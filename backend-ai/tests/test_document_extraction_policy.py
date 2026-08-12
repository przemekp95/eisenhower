from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path

import pytest

from app.document_extraction.models import (
  BoundingBox,
  DocumentInspection,
  ElementKind,
  ExtractedDocument,
  ExtractionElement,
  ExtractionMetadata,
  ExtractionProvenance,
  ExtractionRequest,
  OCRApproval,
  OCRProvenance,
  OCRRequest,
  PromptInjectionSignal,
  SecretScanResult,
  SourceSpan,
  TableData,
)
from app.document_extraction.policy import (
  ExtractionPolicyConfigurationError,
  ExtractionPreflightRejected,
  FrozenManifestExtractionPolicy,
  PreflightRejectionCode,
)


MIME_BY_EXTENSION = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".html": "text/html",
}


def manifest(*, complete_limits: bool = True) -> dict:
  document_policy = {
    "primary_formats": ["pdf", "docx", "pptx", "html"],
    "ocr_enabled": True,
    "ocr_languages": ["pl", "en"],
    "ocr_requires_human_approval": True,
    "maximum_document_bytes": 64,
    "minimum_primary_text_characters": 20,
    "archives": "reject",
    "encrypted_documents": "reject",
    "external_url_fetching": "reject",
  }
  if complete_limits:
    document_policy.update({
      "maximum_document_pages": 10,
      "resource_budget": {
        "maximum_wall_seconds": 5.0,
        "maximum_peak_memory_bytes": 1024,
      },
    })
  return {
    "manifest_version": "test-corpus-v1",
    "incremental_sources": [{
      "root": "corpus/approved-documents",
      "extensions": list(MIME_BY_EXTENSION),
      "source_type": "project_context",
    }],
    "document_policy": document_policy,
  }


def inspection(
  extension: str = ".pdf",
  **overrides,
) -> DocumentInspection:
  values = {
    "media_type": MIME_BY_EXTENSION[extension],
    "page_count": 1,
    "encrypted": False,
    "archive": False,
    "embedded_executable": False,
    "malformed": False,
    "estimated_wall_seconds": 1.0,
    "estimated_peak_memory_bytes": 512,
    "secret_scan": SecretScanResult(completed=True, secret_detected=False),
    "prompt_injection": PromptInjectionSignal(completed=True, detected=False),
  }
  values.update(overrides)
  return DocumentInspection(**values)


def policy(repository_root: Path) -> FrozenManifestExtractionPolicy:
  return FrozenManifestExtractionPolicy.from_manifest(repository_root, manifest())


def rejected(
  extraction_policy: FrozenManifestExtractionPolicy,
  request: ExtractionRequest,
  code: PreflightRejectionCode,
) -> ExtractionPreflightRejected:
  with pytest.raises(ExtractionPreflightRejected) as raised:
    extraction_policy.authorize(request)
  assert raised.value.code is code
  return raised.value


def test_manifest_loader_fails_closed_when_page_or_resource_limits_are_not_frozen(tmp_path):
  with pytest.raises(ExtractionPolicyConfigurationError, match="maximum_document_pages"):
    FrozenManifestExtractionPolicy.from_manifest(tmp_path, manifest(complete_limits=False))


def test_repository_frozen_manifest_configures_the_policy():
  repository_root = Path(__file__).parents[2]
  manifest_path = repository_root / "docs" / "ai-rebuild" / "corpus-manifest-v1.json"
  frozen_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

  extraction_policy = FrozenManifestExtractionPolicy.from_manifest(
    repository_root,
    frozen_manifest,
  )

  assert extraction_policy is not None


@pytest.mark.parametrize("extension,media_type", MIME_BY_EXTENSION.items())
def test_preflight_accepts_only_approved_local_regular_formats(
  tmp_path,
  extension,
  media_type,
):
  approved_root = tmp_path / "corpus" / "approved-documents"
  approved_root.mkdir(parents=True)
  candidate = approved_root / f"reviewed{extension}"
  candidate.write_bytes(b"reviewed document")

  approved = policy(tmp_path).authorize(ExtractionRequest(
    source=str(candidate),
    inspection=inspection(extension, media_type=media_type),
  ))

  assert approved.path == candidate.resolve()
  assert approved.media_type == media_type
  assert approved.size_bytes == len(b"reviewed document")
  assert approved.source_checksum == sha256(b"reviewed document").hexdigest()
  assert approved.manifest_version == "test-corpus-v1"


@pytest.mark.parametrize(
  "source_factory,expected",
  [
    (lambda root: "https://example.invalid/document.pdf", PreflightRejectionCode.EXTERNAL_URL),
    (lambda root: str(root / "outside.pdf"), PreflightRejectionCode.OUTSIDE_APPROVED_ROOT),
    (lambda root: str(root / "corpus" / "approved-documents" / "missing.pdf"), PreflightRejectionCode.NOT_REGULAR_FILE),
  ],
)
def test_preflight_rejects_external_outside_and_non_file_sources(tmp_path, source_factory, expected):
  (tmp_path / "outside.pdf").write_bytes(b"outside")
  (tmp_path / "corpus" / "approved-documents").mkdir(parents=True)
  rejected(
    policy(tmp_path),
    ExtractionRequest(source=source_factory(tmp_path), inspection=inspection()),
    expected,
  )


def test_preflight_rejects_symlink_even_when_target_is_inside_approved_root(tmp_path):
  approved_root = tmp_path / "corpus" / "approved-documents"
  approved_root.mkdir(parents=True)
  target = approved_root / "target.pdf"
  target.write_bytes(b"safe")
  link = approved_root / "link.pdf"
  link.symlink_to(target)

  rejected(
    policy(tmp_path),
    ExtractionRequest(source=str(link), inspection=inspection()),
    PreflightRejectionCode.SYMLINK,
  )


@pytest.mark.parametrize(
  "extension,overrides,expected",
  [
    (".txt", {"media_type": "text/plain"}, PreflightRejectionCode.UNSUPPORTED_EXTENSION),
    (".pdf", {"media_type": "text/html"}, PreflightRejectionCode.MIME_EXTENSION_MISMATCH),
    (".pdf", {"archive": True}, PreflightRejectionCode.ARCHIVE),
    (".pdf", {"encrypted": True}, PreflightRejectionCode.ENCRYPTED),
    (".pdf", {"embedded_executable": True}, PreflightRejectionCode.EMBEDDED_EXECUTABLE),
    (".pdf", {"malformed": True}, PreflightRejectionCode.MALFORMED),
    (".pdf", {"page_count": 11}, PreflightRejectionCode.PAGE_LIMIT),
    (".pdf", {"estimated_wall_seconds": 5.1}, PreflightRejectionCode.RESOURCE_BUDGET),
    (".pdf", {"estimated_peak_memory_bytes": 1025}, PreflightRejectionCode.RESOURCE_BUDGET),
  ],
)
def test_preflight_rejects_unsafe_ambiguous_or_over_budget_input(
  tmp_path,
  extension,
  overrides,
  expected,
):
  approved_root = tmp_path / "corpus" / "approved-documents"
  approved_root.mkdir(parents=True)
  candidate = approved_root / f"candidate{extension}"
  candidate.write_bytes(b"content")

  rejected(
    policy(tmp_path),
    ExtractionRequest(source=str(candidate), inspection=inspection(".pdf", **overrides)),
    expected,
  )


def test_preflight_uses_actual_file_size_instead_of_caller_metadata(tmp_path):
  approved_root = tmp_path / "corpus" / "approved-documents"
  approved_root.mkdir(parents=True)
  candidate = approved_root / "large.pdf"
  candidate.write_bytes(b"x" * 65)

  rejected(
    policy(tmp_path),
    ExtractionRequest(source=str(candidate), inspection=inspection()),
    PreflightRejectionCode.BYTE_LIMIT,
  )


def test_secret_detection_rejects_without_exposing_content_in_error(tmp_path):
  approved_root = tmp_path / "corpus" / "approved-documents"
  approved_root.mkdir(parents=True)
  candidate = approved_root / "secret.pdf"
  secret = "never-log-this-token"
  candidate.write_text(secret, encoding="utf-8")
  secret_scan = SecretScanResult(
    completed=True,
    secret_detected=True,
    finding_types=["api_token"],
  )

  error = rejected(
    policy(tmp_path),
    ExtractionRequest(source=str(candidate), inspection=inspection(secret_scan=secret_scan)),
    PreflightRejectionCode.SECRET_DETECTED,
  )

  assert secret not in str(error)
  assert secret not in repr(error.safe_details)
  assert error.safe_details == {"finding_types": ["api_token"]}


def test_incomplete_secret_or_prompt_injection_inspection_is_rejected(tmp_path):
  approved_root = tmp_path / "corpus" / "approved-documents"
  approved_root.mkdir(parents=True)
  candidate = approved_root / "candidate.pdf"
  candidate.write_bytes(b"content")

  for incomplete in (
    {"secret_scan": SecretScanResult(completed=False, secret_detected=False)},
    {"prompt_injection": PromptInjectionSignal(completed=False, detected=False)},
  ):
    rejected(
      policy(tmp_path),
      ExtractionRequest(source=str(candidate), inspection=inspection(**incomplete)),
      PreflightRejectionCode.INSPECTION_INCOMPLETE,
    )


def test_ocr_is_limited_to_pl_en_and_bound_to_explicit_content_approval(tmp_path):
  approved_root = tmp_path / "corpus" / "approved-documents"
  approved_root.mkdir(parents=True)
  candidate = approved_root / "scan.pdf"
  candidate.write_bytes(b"scanned")
  checksum = sha256(b"scanned").hexdigest()
  approved_manifest = manifest()
  approved_manifest["document_policy"]["ocr_approvals"] = [{
    "approval_id": "approval-2",
    "approver_id": "owner-1",
    "content_sha256": checksum,
    "languages": ["en", "pl"],
    "policy_version": "test-corpus-v1",
  }]
  extraction_policy = FrozenManifestExtractionPolicy.from_manifest(tmp_path, approved_manifest)

  rejected(
    extraction_policy,
    ExtractionRequest(source=str(candidate), inspection=inspection(), ocr=OCRRequest(languages=["pl"])),
    PreflightRejectionCode.OCR_HUMAN_APPROVAL,
  )
  rejected(
    extraction_policy,
    ExtractionRequest(
      source=str(candidate),
      inspection=inspection(),
      ocr=OCRRequest(
        languages=["pl", "en"],
        approval=OCRApproval(
          approval_id="self-asserted-but-not-frozen",
          approver_id="owner-1",
          content_sha256=checksum,
          languages=["pl", "en"],
          policy_version="test-corpus-v1",
        ),
      ),
    ),
    PreflightRejectionCode.OCR_HUMAN_APPROVAL,
  )
  rejected(
    extraction_policy,
    ExtractionRequest(source=str(candidate), inspection=inspection(), ocr=OCRRequest(languages=["de"])),
    PreflightRejectionCode.OCR_LANGUAGE,
  )
  rejected(
    extraction_policy,
    ExtractionRequest(
      source=str(candidate),
      inspection=inspection(),
      ocr=OCRRequest(
        languages=["pl", "en"],
        approval=OCRApproval(
          approval_id="approval-1",
          approver_id="owner-1",
          content_sha256="0" * 64,
          languages=["pl", "en"],
          policy_version="test-corpus-v1",
        ),
      ),
    ),
    PreflightRejectionCode.OCR_HUMAN_APPROVAL,
  )

  approved = extraction_policy.authorize(ExtractionRequest(
    source=str(candidate),
    inspection=inspection(),
    ocr=OCRRequest(
      languages=["pl", "en"],
      approval=OCRApproval(
        approval_id="approval-2",
        approver_id="owner-1",
        content_sha256=checksum,
        languages=["en", "pl"],
        policy_version="test-corpus-v1",
      ),
    ),
  ))
  assert approved.ocr is not None
  assert approved.ocr.approval.approval_id == "approval-2"


def test_prompt_injection_is_preserved_as_inert_security_metadata(tmp_path):
  approved_root = tmp_path / "corpus" / "approved-documents"
  approved_root.mkdir(parents=True)
  candidate = approved_root / "instructions.html"
  candidate.write_bytes(b"<p>ordinary text</p>")
  signal = PromptInjectionSignal(
    completed=True,
    detected=True,
    categories=["instruction_override"],
  )

  approved = policy(tmp_path).authorize(ExtractionRequest(
    source=str(candidate),
    inspection=inspection(".html", prompt_injection=signal),
  ))

  assert approved.security.prompt_injection_detected is True
  assert approved.security.prompt_injection_categories == ["instruction_override"]


def test_normalized_document_preserves_structure_spans_checksums_and_provenance():
  heading = ExtractionElement(
    element_id="heading-1",
    kind=ElementKind.HEADING,
    text="Architecture",
    checksum=sha256(b"Architecture").hexdigest(),
    heading_level=1,
    source_spans=[SourceSpan(
      page_number=1,
      start_offset=0,
      end_offset=12,
      bounding_box=BoundingBox(left=0.1, top=0.1, right=0.9, bottom=0.2),
    )],
  )
  list_item = ExtractionElement(
    element_id="list-1",
    kind=ElementKind.LIST_ITEM,
    text="Fail closed",
    checksum=sha256(b"Fail closed").hexdigest(),
    list_level=1,
    list_marker="-",
    source_spans=[SourceSpan(page_number=1, start_offset=13, end_offset=24)],
  )
  table = ExtractionElement(
    element_id="table-1",
    kind=ElementKind.TABLE,
    text="Parser | Role",
    checksum=sha256(b"Parser | Role").hexdigest(),
    table=TableData(headers=["Parser", "Role"], rows=[["primary", "extract"]]),
    source_spans=[SourceSpan(page_number=2, start_offset=0, end_offset=13)],
  )

  document = ExtractedDocument(
    source_uri="eisenhower://repository/corpus/approved-documents/design.pdf",
    source_checksum="1" * 64,
    extraction_checksum="2" * 64,
    media_type="application/pdf",
    elements=[heading, list_item, table],
    provenance=ExtractionProvenance(
      extractor_name="primary",
      extractor_version="1.2.3",
      extraction_contract_version="document-extraction-v1",
      ocr=OCRProvenance(
        requested=True,
        performed=True,
        languages=["pl", "en"],
        engine_name="local-ocr",
        engine_version="4.0",
        human_approval_id="approval-2",
      ),
    ),
    metadata=ExtractionMetadata(
      prompt_injection_detected=True,
      prompt_injection_categories=["instruction_override"],
    ),
  )

  assert [element.kind for element in document.elements] == [
    ElementKind.HEADING,
    ElementKind.LIST_ITEM,
    ElementKind.TABLE,
  ]
  assert document.elements[0].source_spans[0].page_number == 1
  assert document.elements[2].table.rows == [["primary", "extract"]]
  assert document.provenance.ocr.human_approval_id == "approval-2"
