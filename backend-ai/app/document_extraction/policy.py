from __future__ import annotations

from collections.abc import Mapping
from enum import Enum
from hashlib import sha256
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from pydantic import ValidationError

from .models import (
  ApprovedExtractionRequest,
  ExtractionLimits,
  ExtractionRequest,
  ExtractionSecurityMetadata,
  OCRApproval,
)


MEDIA_TYPES_BY_EXTENSION = {
  ".pdf": frozenset({"application/pdf"}),
  ".docx": frozenset({
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }),
  ".pptx": frozenset({
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  }),
  ".html": frozenset({"text/html", "application/xhtml+xml"}),
}


class ExtractionPolicyConfigurationError(ValueError):
  """The frozen manifest cannot safely configure document extraction."""


class PreflightRejectionCode(str, Enum):
  EXTERNAL_URL = "external_url_forbidden"
  OUTSIDE_APPROVED_ROOT = "outside_approved_root"
  NOT_REGULAR_FILE = "not_regular_file"
  SYMLINK = "symlink_forbidden"
  UNSUPPORTED_EXTENSION = "unsupported_extension"
  MIME_EXTENSION_MISMATCH = "mime_extension_mismatch"
  ARCHIVE = "archive_forbidden"
  ENCRYPTED = "encrypted_document"
  EMBEDDED_EXECUTABLE = "embedded_executable"
  MALFORMED = "malformed_document"
  BYTE_LIMIT = "document_byte_limit_exceeded"
  PAGE_LIMIT = "document_page_limit_exceeded"
  RESOURCE_BUDGET = "resource_budget_exceeded"
  INSPECTION_INCOMPLETE = "security_inspection_incomplete"
  SECRET_DETECTED = "secret_detected"
  OCR_DISABLED = "ocr_disabled"
  OCR_LANGUAGE = "ocr_language_not_approved"
  OCR_HUMAN_APPROVAL = "ocr_human_approval_required"


class ExtractionPreflightRejected(ValueError):
  def __init__(
    self,
    code: PreflightRejectionCode,
    safe_details: Mapping[str, Any] | None = None,
  ):
    self.code = code
    self.safe_details = dict(safe_details or {})
    super().__init__(code.value)


class FrozenManifestExtractionPolicy:
  def __init__(
    self,
    *,
    repository_root: Path,
    approved_root: Path,
    manifest_version: str,
    extensions: frozenset[str],
    limits: ExtractionLimits,
    minimum_primary_text_characters: int,
    ocr_enabled: bool,
    ocr_languages: frozenset[str],
    ocr_requires_human_approval: bool,
    ocr_approvals: frozenset[tuple[str, str, str, frozenset[str], str]],
  ):
    self._repository_root = repository_root
    self._approved_root = approved_root
    self._manifest_version = manifest_version
    self._extensions = extensions
    self._limits = limits
    self._minimum_primary_text_characters = minimum_primary_text_characters
    self._ocr_enabled = ocr_enabled
    self._ocr_languages = ocr_languages
    self._ocr_requires_human_approval = ocr_requires_human_approval
    self._ocr_approvals = ocr_approvals

  @classmethod
  def from_manifest(
    cls,
    repository_root: Path,
    manifest: Mapping[str, Any],
  ) -> FrozenManifestExtractionPolicy:
    manifest_version = _required_text(manifest, "manifest_version")
    document_policy = _required_mapping(manifest, "document_policy")
    maximum_document_bytes = _required_positive_number(
      document_policy,
      "maximum_document_bytes",
      integer=True,
    )
    maximum_document_pages = _required_positive_number(
      document_policy,
      "maximum_document_pages",
      integer=True,
    )
    resource_budget = _required_mapping(document_policy, "resource_budget")
    maximum_wall_seconds = _required_positive_number(
      resource_budget,
      "maximum_wall_seconds",
      integer=False,
    )
    maximum_peak_memory_bytes = _required_positive_number(
      resource_budget,
      "maximum_peak_memory_bytes",
      integer=True,
    )
    limits = ExtractionLimits(
      maximum_document_bytes=maximum_document_bytes,
      maximum_document_pages=maximum_document_pages,
      maximum_wall_seconds=maximum_wall_seconds,
      maximum_peak_memory_bytes=maximum_peak_memory_bytes,
    )
    minimum_primary_text_characters = _required_positive_number(
      document_policy,
      "minimum_primary_text_characters",
      integer=True,
    )

    source = _document_source(manifest)
    root_value = _required_text(source, "root")
    root_path = Path(root_value)
    if root_path.is_absolute() or ".." in root_path.parts or urlsplit(root_value).scheme:
      raise ExtractionPolicyConfigurationError("document source root must be repository-relative")

    extensions_value = source.get("extensions")
    if not isinstance(extensions_value, list) or not extensions_value:
      raise ExtractionPolicyConfigurationError("document source extensions are required")
    extensions = frozenset(str(item).lower() for item in extensions_value)
    if any(extension not in MEDIA_TYPES_BY_EXTENSION for extension in extensions):
      raise ExtractionPolicyConfigurationError("document source contains an unsupported extension")

    formats_value = document_policy.get("primary_formats")
    expected_formats = {extension.removeprefix(".") for extension in extensions}
    if not isinstance(formats_value, list) or set(formats_value) != expected_formats:
      raise ExtractionPolicyConfigurationError("primary formats must match source extensions")
    for key in ("archives", "encrypted_documents", "external_url_fetching"):
      if document_policy.get(key) != "reject":
        raise ExtractionPolicyConfigurationError(f"{key} must be fail-closed")

    ocr_languages_value = document_policy.get("ocr_languages")
    if not isinstance(ocr_languages_value, list) or not ocr_languages_value:
      raise ExtractionPolicyConfigurationError("ocr_languages must be frozen")
    ocr_languages = frozenset(str(item) for item in ocr_languages_value)
    if not ocr_languages.issubset({"pl", "en"}):
      raise ExtractionPolicyConfigurationError("only pl/en OCR may be approved")
    ocr_enabled = document_policy.get("ocr_enabled") is True
    ocr_requires_human_approval = document_policy.get("ocr_requires_human_approval") is True
    if ocr_enabled and not ocr_requires_human_approval:
      raise ExtractionPolicyConfigurationError("OCR must require explicit human approval")
    ocr_approvals = _ocr_approval_keys(document_policy.get("ocr_approvals", []))

    resolved_repository_root = repository_root.resolve(strict=True)
    approved_root = (resolved_repository_root / root_path).resolve(strict=True)
    if not approved_root.is_dir():
      raise ExtractionPolicyConfigurationError("approved document root must be a directory")
    try:
      approved_root.relative_to(resolved_repository_root)
    except ValueError as exc:
      raise ExtractionPolicyConfigurationError("approved document root escaped repository") from exc

    return cls(
      repository_root=resolved_repository_root,
      approved_root=approved_root,
      manifest_version=manifest_version,
      extensions=extensions,
      limits=limits,
      minimum_primary_text_characters=minimum_primary_text_characters,
      ocr_enabled=ocr_enabled,
      ocr_languages=ocr_languages,
      ocr_requires_human_approval=ocr_requires_human_approval,
      ocr_approvals=ocr_approvals,
    )

  def authorize(self, request: ExtractionRequest) -> ApprovedExtractionRequest:
    candidate = self._local_candidate(request.source)
    self._validate_path(candidate)
    inspection = request.inspection
    extension = candidate.suffix.lower()
    if extension not in self._extensions:
      self._reject(PreflightRejectionCode.UNSUPPORTED_EXTENSION, extension=extension)
    if inspection.archive:
      self._reject(PreflightRejectionCode.ARCHIVE)
    if inspection.encrypted:
      self._reject(PreflightRejectionCode.ENCRYPTED)
    if inspection.embedded_executable:
      self._reject(PreflightRejectionCode.EMBEDDED_EXECUTABLE)

    media_type = inspection.media_type.lower().split(";", maxsplit=1)[0].strip()
    if media_type not in MEDIA_TYPES_BY_EXTENSION[extension]:
      self._reject(
        PreflightRejectionCode.MIME_EXTENSION_MISMATCH,
        extension=extension,
        media_type=media_type,
      )
    if not inspection.secret_scan.completed or not inspection.prompt_injection.completed:
      self._reject(PreflightRejectionCode.INSPECTION_INCOMPLETE)
    if inspection.secret_scan.secret_detected:
      self._reject(
        PreflightRejectionCode.SECRET_DETECTED,
        finding_types=inspection.secret_scan.finding_types,
      )
    if inspection.malformed:
      self._reject(PreflightRejectionCode.MALFORMED)

    size_bytes = candidate.stat().st_size
    if size_bytes > self._limits.maximum_document_bytes:
      self._reject(PreflightRejectionCode.BYTE_LIMIT, size_bytes=size_bytes)
    if inspection.page_count > self._limits.maximum_document_pages:
      self._reject(PreflightRejectionCode.PAGE_LIMIT, page_count=inspection.page_count)
    if (
      inspection.estimated_wall_seconds > self._limits.maximum_wall_seconds
      or inspection.estimated_peak_memory_bytes > self._limits.maximum_peak_memory_bytes
    ):
      self._reject(PreflightRejectionCode.RESOURCE_BUDGET)

    source_checksum = _file_sha256(candidate)
    self._validate_ocr(request, source_checksum)
    security = ExtractionSecurityMetadata(
      prompt_injection_detected=inspection.prompt_injection.detected,
      prompt_injection_categories=inspection.prompt_injection.categories,
    )
    return ApprovedExtractionRequest(
      path=candidate,
      source_uri=f"eisenhower://repository/{candidate.relative_to(self._repository_root).as_posix()}",
      media_type=media_type,
      source_checksum=source_checksum,
      size_bytes=size_bytes,
      page_count=inspection.page_count,
      manifest_version=self._manifest_version,
      limits=self._limits,
      minimum_primary_text_characters=self._minimum_primary_text_characters,
      ocr=request.ocr,
      security=security,
    )

  def _local_candidate(self, source: str) -> Path:
    parsed = urlsplit(source)
    if parsed.scheme or parsed.netloc or source.startswith("//"):
      self._reject(PreflightRejectionCode.EXTERNAL_URL)
    path = Path(source)
    if not path.is_absolute():
      path = self._repository_root / path
    return path.absolute()

  def _validate_path(self, candidate: Path) -> None:
    try:
      relative = candidate.relative_to(self._approved_root)
    except ValueError:
      self._reject(PreflightRejectionCode.OUTSIDE_APPROVED_ROOT)
    current = self._approved_root
    for part in relative.parts:
      current /= part
      if current.is_symlink():
        self._reject(PreflightRejectionCode.SYMLINK)
    if not candidate.is_file():
      self._reject(PreflightRejectionCode.NOT_REGULAR_FILE)
    try:
      candidate.resolve(strict=True).relative_to(self._approved_root)
    except (OSError, ValueError):
      self._reject(PreflightRejectionCode.OUTSIDE_APPROVED_ROOT)

  def _validate_ocr(self, request: ExtractionRequest, source_checksum: str) -> None:
    if request.ocr is None:
      return
    if not self._ocr_enabled:
      self._reject(PreflightRejectionCode.OCR_DISABLED)
    languages = frozenset(request.ocr.languages)
    if not languages.issubset(self._ocr_languages):
      self._reject(PreflightRejectionCode.OCR_LANGUAGE)
    if not self._ocr_requires_human_approval:
      return
    approval = request.ocr.approval
    if (
      approval is None
      or approval.content_sha256 != source_checksum
      or frozenset(approval.languages) != languages
      or approval.policy_version != self._manifest_version
      or _ocr_approval_key(approval) not in self._ocr_approvals
    ):
      self._reject(PreflightRejectionCode.OCR_HUMAN_APPROVAL)

  @staticmethod
  def _reject(code: PreflightRejectionCode, **safe_details: Any) -> None:
    raise ExtractionPreflightRejected(code, safe_details)


def _document_source(manifest: Mapping[str, Any]) -> Mapping[str, Any]:
  sources = manifest.get("incremental_sources")
  if not isinstance(sources, list):
    raise ExtractionPolicyConfigurationError("incremental_sources must be frozen")
  matching = [
    source
    for source in sources
    if isinstance(source, Mapping) and source.get("root") == "corpus/approved-documents"
  ]
  if len(matching) != 1:
    raise ExtractionPolicyConfigurationError("exactly one approved document source is required")
  return matching[0]


def _required_mapping(source: Mapping[str, Any], key: str) -> Mapping[str, Any]:
  value = source.get(key)
  if not isinstance(value, Mapping):
    raise ExtractionPolicyConfigurationError(f"{key} must be frozen")
  return value


def _required_text(source: Mapping[str, Any], key: str) -> str:
  value = source.get(key)
  if not isinstance(value, str) or not value.strip():
    raise ExtractionPolicyConfigurationError(f"{key} must be frozen")
  return value


def _required_positive_number(
  source: Mapping[str, Any],
  key: str,
  *,
  integer: bool,
) -> int | float:
  value = source.get(key)
  expected = int if integer else (int, float)
  if isinstance(value, bool) or not isinstance(value, expected) or value <= 0:
    raise ExtractionPolicyConfigurationError(f"{key} must be a positive approved limit")
  return value


def _ocr_approval_key(
  approval: OCRApproval,
) -> tuple[str, str, str, frozenset[str], str]:
  return (
    approval.approval_id,
    approval.approver_id,
    approval.content_sha256,
    frozenset(approval.languages),
    approval.policy_version,
  )


def _ocr_approval_keys(
  value: Any,
) -> frozenset[tuple[str, str, str, frozenset[str], str]]:
  if not isinstance(value, list):
    raise ExtractionPolicyConfigurationError("ocr_approvals must be a frozen list")
  try:
    approvals = [OCRApproval.model_validate(item) for item in value]
  except ValidationError as exc:
    raise ExtractionPolicyConfigurationError("ocr_approvals contain an invalid receipt") from exc
  keys = [_ocr_approval_key(approval) for approval in approvals]
  if len(keys) != len(set(keys)):
    raise ExtractionPolicyConfigurationError("ocr_approvals must be unique")
  return frozenset(keys)


def _file_sha256(path: Path) -> str:
  digest = sha256()
  with path.open("rb") as handle:
    for chunk in iter(lambda: handle.read(64 * 1024), b""):
      digest.update(chunk)
  return digest.hexdigest()
