from __future__ import annotations

from datetime import UTC, datetime
from io import BytesIO

import pytest

from app.artifacts.models import ArtifactReference, CandidateManifest, GitLineage, LineageGroup, RuntimeLineage
from app.artifacts.registry import ArtifactConflictError
from app.artifacts.s3_registry import S3ImmutableArtifactRegistry


class PreconditionFailed(RuntimeError):
  response = {"ResponseMetadata": {"HTTPStatusCode": 412}}


class FakeS3:
  def __init__(self):
    self.objects: dict[tuple[str, str], bytes] = {}
    self.put_calls: list[dict] = []

  def put_object(self, **kwargs):
    self.put_calls.append(kwargs)
    identity = (kwargs["Bucket"], kwargs["Key"])
    if kwargs.get("IfNoneMatch") == "*" and identity in self.objects:
      raise PreconditionFailed()
    self.objects[identity] = kwargs["Body"]

  def get_object(self, **kwargs):
    try:
      data = self.objects[(kwargs["Bucket"], kwargs["Key"])]
    except KeyError as issue:
      raise FileNotFoundError(kwargs["Key"]) from issue
    return {"Body": BytesIO(data)}


def reference(checksum: str) -> ArtifactReference:
  return ArtifactReference(name="report", revision="v1", sha256=checksum, uri=f"registry://sha256/{checksum}")


def manifest(checksum: str) -> CandidateManifest:
  group = LineageGroup(items=(reference(checksum),))
  gap = LineageGroup(not_applicable_reason="not used by this workflow")
  return CandidateManifest.create(
    candidate_id="mlops-s3-test", workflow="mlops", evidence_level="local_in_process",
    created_at=datetime(2026, 9, 7, tzinfo=UTC), git=GitLineage(commit_sha="a" * 40, dirty=False),
    datasets=group, models=group, prompts=gap, schemas=group, corpora=gap,
    qdrant_collections=gap, runtimes=(RuntimeLineage(name="python", version="3.12", digest=checksum),),
    reports=group,
  )


def test_s3_registry_writes_content_addressed_objects_once_and_verifies_manifests():
  client = FakeS3()
  registry = S3ImmutableArtifactRegistry(client, bucket="private-artifacts", prefix="model-artifacts")

  artifact = registry.register_bytes(b"verified evidence", name="report", revision="v1")
  candidate = manifest(artifact.sha256)
  location = registry.register_manifest(candidate)

  assert location == "s3://private-artifacts/model-artifacts/manifests/mlops-s3-test.json"
  assert registry.verify_manifest(candidate.candidate_id) == candidate
  assert all(call["IfNoneMatch"] == "*" for call in client.put_calls)
  assert all("ACL" not in call for call in client.put_calls)
  assert all(call["ServerSideEncryption"] == "AES256" for call in client.put_calls)


def test_s3_registry_accepts_an_identical_replay_but_rejects_drift_and_corruption():
  client = FakeS3()
  registry = S3ImmutableArtifactRegistry(client, bucket="private-artifacts")
  artifact = registry.register_bytes(b"evidence", name="report", revision="v1")
  candidate = manifest(artifact.sha256)
  registry.register_manifest(candidate)
  assert registry.register_manifest(candidate).endswith("mlops-s3-test.json")

  manifest_key = ("private-artifacts", "model-artifacts/manifests/mlops-s3-test.json")
  valid_manifest = client.objects[manifest_key]
  client.objects[manifest_key] = b"{}"
  with pytest.raises(ArtifactConflictError, match="conflicting or corrupt"):
    registry.register_manifest(candidate)

  client.objects[manifest_key] = valid_manifest
  blob_key = ("private-artifacts", f"model-artifacts/blobs/sha256/{artifact.sha256}")
  client.objects[blob_key] = b"tampered"
  with pytest.raises(ArtifactConflictError, match="checksum"):
    registry.verify_manifest(candidate.candidate_id)
