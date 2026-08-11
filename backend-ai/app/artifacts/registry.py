from __future__ import annotations

from hashlib import sha256
import json
import os
from pathlib import Path

from .models import ArtifactReference, CandidateManifest


class ArtifactConflictError(RuntimeError):
  """Raised when immutable registry state is missing, conflicting or corrupted."""


class ImmutableArtifactRegistry:
  """Private filesystem registry with content-addressed blobs and immutable manifests."""

  def __init__(self, root: str | Path):
    self.root = Path(root).resolve()
    self.blobs = self.root / "blobs" / "sha256"
    self.manifests = self.root / "manifests"
    for directory in (self.root, self.blobs, self.manifests):
      directory.mkdir(parents=True, exist_ok=True, mode=0o700)
      directory.chmod(0o700)

  def blob_path(self, checksum: str) -> Path:
    if len(checksum) != 64 or any(character not in "0123456789abcdef" for character in checksum):
      raise ValueError("blob checksum must be a lowercase SHA-256")
    return self.blobs / checksum

  def register_file(self, source: str | Path, *, name: str, revision: str) -> ArtifactReference:
    source_path = Path(source)
    return self.register_bytes(source_path.read_bytes(), name=name, revision=revision)

  def register_bytes(self, data: bytes, *, name: str, revision: str) -> ArtifactReference:
    checksum = sha256(data).hexdigest()
    target = self.blob_path(checksum)
    if target.exists():
      self._verify_blob(checksum)
    else:
      self._exclusive_write(target, data)
    return ArtifactReference(
      name=name,
      revision=revision,
      sha256=checksum,
      uri=f"registry://sha256/{checksum}",
    )

  def register_manifest(self, manifest: CandidateManifest) -> Path:
    if not manifest.verify_checksum():
      raise ArtifactConflictError("manifest checksum does not match canonical lineage")
    for reference in manifest.artifact_references():
      if not self.blob_path(reference.sha256).exists():
        raise ArtifactConflictError(f"missing registry blob: {reference.sha256}")
      self._verify_blob(reference.sha256)
    target = self.manifests / f"{manifest.candidate_id}.json"
    data = (manifest.model_dump_json(indent=2) + "\n").encode("utf-8")
    if target.exists():
      existing = target.read_bytes()
      if existing != data:
        raise ArtifactConflictError(f"candidate id already registered: {manifest.candidate_id}")
      self._verify_manifest_file(target, manifest.candidate_id)
      return target
    self._exclusive_write(target, data)
    return target

  def verify_manifest(self, candidate_id: str) -> CandidateManifest:
    target = self.manifests / f"{candidate_id}.json"
    return self._verify_manifest_file(target, candidate_id)

  def _verify_manifest_file(self, target: Path, candidate_id: str) -> CandidateManifest:
    if not target.exists():
      raise ArtifactConflictError(f"candidate manifest is missing: {candidate_id}")
    try:
      manifest = CandidateManifest.model_validate(json.loads(target.read_text(encoding="utf-8")))
    except (OSError, ValueError, json.JSONDecodeError) as issue:
      raise ArtifactConflictError(f"candidate manifest is invalid: {candidate_id}") from issue
    if manifest.candidate_id != candidate_id:
      raise ArtifactConflictError("candidate manifest identity mismatch")
    for reference in manifest.artifact_references():
      self._verify_blob(reference.sha256)
    return manifest

  def _verify_blob(self, checksum: str) -> None:
    target = self.blob_path(checksum)
    if not target.exists():
      raise ArtifactConflictError(f"missing registry blob: {checksum}")
    if sha256(target.read_bytes()).hexdigest() != checksum:
      raise ArtifactConflictError(f"registry blob checksum mismatch: {checksum}")

  @staticmethod
  def _exclusive_write(target: Path, data: bytes) -> None:
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
      with os.fdopen(descriptor, "wb", closefd=False) as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    finally:
      os.close(descriptor)
    target.chmod(0o600)
    directory_descriptor = os.open(target.parent, os.O_RDONLY)
    try:
      os.fsync(directory_descriptor)
    finally:
      os.close(directory_descriptor)
