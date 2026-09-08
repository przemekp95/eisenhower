from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from typing import Any, Protocol

from pydantic import ValidationError

from .models import ArtifactReference, CandidateManifest
from .registry import ArtifactConflictError


class S3Client(Protocol):
  def put_object(self, **kwargs: Any) -> Any: ...
  def get_object(self, **kwargs: Any) -> dict[str, Any]: ...


class S3ImmutableArtifactRegistry:
  """Private content-addressed registry using conditional, immutable S3 writes."""

  def __init__(self, client: S3Client, *, bucket: str, prefix: str = "model-artifacts"):
    if not bucket or not prefix.strip("/"):
      raise ValueError("S3 registry bucket and prefix are required")
    self.client = client
    self.bucket = bucket
    self.prefix = prefix.strip("/")

  def register_file(self, source: str | Path, *, name: str, revision: str) -> ArtifactReference:
    return self.register_bytes(Path(source).read_bytes(), name=name, revision=revision)

  def register_bytes(self, data: bytes, *, name: str, revision: str) -> ArtifactReference:
    checksum = sha256(data).hexdigest()
    self._put_immutable(self._blob_key(checksum), data, checksum, "application/octet-stream")
    return ArtifactReference(
      name=name, revision=revision, sha256=checksum, uri=f"registry://sha256/{checksum}",
    )

  def register_manifest(self, manifest: CandidateManifest) -> str:
    if not manifest.verify_checksum():
      raise ArtifactConflictError("manifest checksum does not match canonical lineage")
    for reference in manifest.artifact_references():
      self._verify_blob(reference.sha256)
    data = (manifest.model_dump_json(indent=2) + "\n").encode("utf-8")
    key = self._manifest_key(manifest.candidate_id)
    self._put_immutable(key, data, sha256(data).hexdigest(), "application/json")
    return f"s3://{self.bucket}/{key}"

  def verify_manifest(self, candidate_id: str) -> CandidateManifest:
    data = self._read(self._manifest_key(candidate_id), f"candidate manifest is missing: {candidate_id}")
    try:
      manifest = CandidateManifest.model_validate_json(data)
    except (ValidationError, ValueError) as issue:
      raise ArtifactConflictError(f"candidate manifest is invalid: {candidate_id}") from issue
    if manifest.candidate_id != candidate_id:
      raise ArtifactConflictError("candidate manifest identity mismatch")
    for reference in manifest.artifact_references():
      self._verify_blob(reference.sha256)
    return manifest

  def _blob_key(self, checksum: str) -> str:
    if len(checksum) != 64 or any(char not in "0123456789abcdef" for char in checksum):
      raise ValueError("blob checksum must be a lowercase SHA-256")
    return f"{self.prefix}/blobs/sha256/{checksum}"

  def _manifest_key(self, candidate_id: str) -> str:
    return f"{self.prefix}/manifests/{candidate_id}.json"

  def _put_immutable(self, key: str, data: bytes, checksum: str, content_type: str) -> None:
    try:
      self.client.put_object(
        Bucket=self.bucket,
        Key=key,
        Body=data,
        ContentType=content_type,
        ServerSideEncryption="AES256",
        Metadata={"sha256": checksum},
        IfNoneMatch="*",
      )
      return
    except Exception as issue:  # SDK exception types remain outside the domain adapter.
      status = getattr(issue, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode")
      if status != 412:
        raise
    existing = self._read(key, f"immutable object disappeared after conflict: {key}")
    if existing != data:
      raise ArtifactConflictError(f"immutable S3 object is conflicting or corrupt: {key}")

  def _verify_blob(self, checksum: str) -> None:
    data = self._read(self._blob_key(checksum), f"missing registry blob: {checksum}")
    if sha256(data).hexdigest() != checksum:
      raise ArtifactConflictError(f"registry blob checksum mismatch: {checksum}")

  def _read(self, key: str, missing_message: str) -> bytes:
    try:
      body = self.client.get_object(Bucket=self.bucket, Key=key)["Body"]
      return body.read()
    except ArtifactConflictError:
      raise
    except Exception as issue:
      raise ArtifactConflictError(missing_message) from issue
