from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path, PurePosixPath
import unicodedata

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr

from .models import AccessScope, SourceDocument


class ManifestViolation(ValueError):
  pass


class Snapshot(BaseModel):
  model_config = ConfigDict(extra="forbid")
  algorithm: str
  sha256: str = Field(..., pattern=r"^[a-f0-9]{64}$")
  document_count: int = Field(..., ge=1)
  total_bytes: int = Field(..., ge=1)
  documents: list[str]


class DocumentPolicy(BaseModel):
  model_config = ConfigDict(extra="allow")
  maximum_document_bytes: int = Field(..., ge=1)
  maximum_documents: int = Field(..., ge=1)


class IdentityAndAcl(BaseModel):
  model_config = ConfigDict(extra="allow")
  initial_tenant: str = Field(..., min_length=1)
  cross_tenant_access: bool
  request_payload_may_expand_scope: bool


class IncrementalSource(BaseModel):
  model_config = ConfigDict(extra="allow")
  root: str = Field(..., min_length=1)
  files: list[str] | None = None
  extensions: list[str] | None = None
  source_type: str = Field(..., min_length=1)


class CorpusManifest(BaseModel):
  model_config = ConfigDict(extra="allow")
  manifest_version: str
  initial_snapshot: Snapshot
  document_policy: DocumentPolicy
  identity_and_acl: IdentityAndAcl
  incremental_sources: list[IncrementalSource] = Field(default_factory=list)
  _artifact_sha256: str = PrivateAttr()

  @classmethod
  def load(cls, path: Path) -> "CorpusManifest":
    raw = path.read_bytes()
    manifest = cls.model_validate_json(raw)
    manifest._artifact_sha256 = sha256(raw).hexdigest()
    return manifest

  @property
  def artifact_checksum(self) -> str:
    return f"sha256:{self._artifact_sha256}"


def normalize_source_text(text: str) -> str:
  text = unicodedata.normalize("NFC", text.replace("\r\n", "\n").replace("\r", "\n"))
  return "\n".join(line.rstrip() for line in text.split("\n")).strip()


class RepositoryCorpusConnector:
  def __init__(self, root: Path, manifest: CorpusManifest):
    self.root = root.resolve()
    self.manifest = manifest
    documents = manifest.initial_snapshot.documents
    if len(documents) != manifest.initial_snapshot.document_count or len(documents) > manifest.document_policy.maximum_documents:
      raise ManifestViolation("manifest document count is invalid")
    for relative in documents:
      self._validate_relative_path(relative)
    for source in manifest.incremental_sources:
      self._validate_relative_path(source.root)
      for relative in source.files or []:
        self._validate_relative_path(relative)

  def _verified_sources(self) -> list[tuple[str, bytes]]:
    records = []
    total_bytes = 0
    verified = []
    for relative in sorted(self.manifest.initial_snapshot.documents):
      candidate = self.root / relative
      if candidate.is_symlink():
        raise ManifestViolation("symlink sources are forbidden")
      resolved = candidate.resolve()
      if not resolved.is_relative_to(self.root) or not resolved.is_file():
        raise ManifestViolation("source escapes the repository root")
      raw = resolved.read_bytes()
      size = len(raw)
      if size > self.manifest.document_policy.maximum_document_bytes:
        raise ManifestViolation("source exceeds the document size limit")
      total_bytes += size
      digest = sha256(raw).hexdigest()
      records.append(f"{digest}  {relative}\n")
      verified.append((relative, raw))
    snapshot = sha256("".join(records).encode("utf-8")).hexdigest()
    if snapshot != self.manifest.initial_snapshot.sha256 or total_bytes != self.manifest.initial_snapshot.total_bytes:
      raise ManifestViolation("source snapshot does not match the approved manifest")
    return verified

  def load_initial(self, scope: AccessScope) -> list[SourceDocument]:
    documents = []
    for relative, raw in self._verified_sources():
      text = normalize_source_text(raw.decode("utf-8"))
      checksum = sha256(text.encode("utf-8")).hexdigest()
      source_type = "decision" if "/adr/" in f"/{relative}" else "project_context"
      documents.append(
        SourceDocument(
          document_id=sha256(relative.encode("utf-8")).hexdigest(),
          tenant_id=scope.tenant_id,
          project_id=scope.project_ids[0] if scope.project_ids else None,
          owner_id=scope.user_id,
          source_type=source_type,
          source_uri=f"eisenhower://repository/{relative}",
          title=Path(relative).stem.replace("-", " ").strip(),
          text=text,
          source_revision=checksum,
          content_version=f"{self.manifest.manifest_version}:{checksum}",
          content_checksum=checksum,
          source_sequence=1,
          acl_subjects=scope.acl_subjects,
        )
      )
    return documents

  def load_incremental_markdown(self, scope: AccessScope, *, source_sequence: int) -> list[SourceDocument]:
    if source_sequence < 1:
      raise ManifestViolation("incremental source_sequence must be positive")
    documents = []
    for source in self.manifest.incremental_sources:
      if not source.files:
        continue
      for filename in sorted(source.files):
        relative = str(PurePosixPath(source.root) / filename)
        if PurePosixPath(relative).suffix.lower() != ".md":
          raise ManifestViolation("file-based incremental sources must be Markdown")
        path = self._verified_incremental_path(relative)
        text = normalize_source_text(path.read_text(encoding="utf-8"))
        checksum = sha256(text.encode("utf-8")).hexdigest()
        documents.append(
          SourceDocument(
            document_id=sha256(relative.encode("utf-8")).hexdigest(),
            tenant_id=scope.tenant_id,
            project_id=scope.project_ids[0] if scope.project_ids else None,
            owner_id=scope.user_id,
            source_type=source.source_type,
            source_uri=f"eisenhower://repository/{relative}",
            title=path.stem.replace("-", " ").strip(),
            text=text,
            source_revision=checksum,
            content_version=f"{self.manifest.manifest_version}:{checksum}",
            content_checksum=checksum,
            source_sequence=source_sequence,
            acl_subjects=scope.acl_subjects,
          )
        )
    return documents

  def _verified_incremental_path(self, relative: str) -> Path:
    self._validate_relative_path(relative)
    candidate = self.root / relative
    if candidate.is_symlink():
      raise ManifestViolation("symlink sources are forbidden")
    resolved = candidate.resolve()
    if not resolved.is_relative_to(self.root) or not resolved.is_file():
      raise ManifestViolation("incremental source escapes the repository root")
    if resolved.stat().st_size > self.manifest.document_policy.maximum_document_bytes:
      raise ManifestViolation("source exceeds the document size limit")
    return resolved

  @staticmethod
  def _validate_relative_path(relative: str) -> None:
    path = PurePosixPath(relative)
    if path.is_absolute() or ".." in path.parts or not path.parts:
      raise ManifestViolation("source paths must be safe relative paths")
