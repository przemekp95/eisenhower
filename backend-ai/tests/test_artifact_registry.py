from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.artifacts.models import (
  ArtifactReference,
  CandidateManifest,
  GitLineage,
  LineageGroup,
  RuntimeLineage,
)
from app.artifacts.registry import ArtifactConflictError, ImmutableArtifactRegistry
from app.artifacts.cli import main as registry_cli


def _reference(name: str, revision: str, checksum: str) -> ArtifactReference:
  return ArtifactReference(
    name=name,
    revision=revision,
    sha256=checksum,
    uri=f"registry://sha256/{checksum}",
  )


def _manifest(checksum: str, *, candidate_id: str = "mlops-20260811-test") -> CandidateManifest:
  return CandidateManifest.create(
    candidate_id=candidate_id,
    workflow="mlops",
    evidence_level="local_in_process",
    created_at=datetime(2026, 8, 11, 10, 0, tzinfo=UTC),
    git=GitLineage(commit_sha="a" * 40, dirty=False),
    datasets=LineageGroup(items=(_reference("training", "training-v1", checksum),)),
    models=LineageGroup(items=(_reference("minilm", "sentence-transformers-v1", checksum),)),
    prompts=LineageGroup(not_applicable_reason="classifier candidate does not execute a prompt"),
    schemas=LineageGroup(items=(_reference("training-schema", "1.0.0", checksum),)),
    corpora=LineageGroup(not_applicable_reason="classifier candidate has no RAG corpus"),
    qdrant_collections=LineageGroup(
      not_applicable_reason="classifier candidate does not build a vector collection"
    ),
    runtimes=(RuntimeLineage(name="python", version="3.12.11", digest=checksum),),
    reports=LineageGroup(items=(_reference("quality-report", "candidate-v1", checksum),)),
  )


def test_manifest_is_canonical_checksummed_and_requires_explicit_lineage_gaps():
  checksum = "b" * 64
  manifest = _manifest(checksum)

  assert manifest.verify_checksum()
  assert CandidateManifest.model_validate_json(manifest.model_dump_json()).verify_checksum()
  assert manifest.canonical_json() == CandidateManifest.model_validate_json(
    manifest.model_dump_json()
  ).canonical_json()

  with pytest.raises(ValidationError, match="items or not_applicable_reason"):
    LineageGroup()
  with pytest.raises(ValidationError, match="not both"):
    LineageGroup(
      items=(_reference("data", "v1", checksum),),
      not_applicable_reason="unused in this workflow",
    )


def test_registry_is_content_addressed_private_immutable_and_detects_tampering(tmp_path):
  registry = ImmutableArtifactRegistry(tmp_path / "registry")
  source = tmp_path / "report.json"
  source.write_bytes(b'{"passed":true}\n')

  reference = registry.register_file(source, name="quality-report", revision="candidate-v1")
  manifest = _manifest(reference.sha256)
  stored = registry.register_manifest(manifest)

  assert stored == registry.register_manifest(manifest)
  assert stored.stat().st_mode & 0o777 == 0o600
  assert registry.verify_manifest(manifest.candidate_id) == manifest

  conflicting = _manifest(reference.sha256, candidate_id=manifest.candidate_id).model_copy(
    update={"git": GitLineage(commit_sha="c" * 40, dirty=False), "manifest_checksum": "0" * 64}
  )
  conflicting = conflicting.model_copy(
    update={"manifest_checksum": conflicting.compute_checksum()}
  )
  with pytest.raises(ArtifactConflictError, match="already registered"):
    registry.register_manifest(conflicting)

  blob = registry.blob_path(reference.sha256)
  blob.chmod(0o600)
  blob.write_bytes(b"tampered")
  with pytest.raises(ArtifactConflictError, match="checksum"):
    registry.verify_manifest(manifest.candidate_id)


def test_registry_rejects_manifest_with_unregistered_or_drifted_reference(tmp_path):
  registry = ImmutableArtifactRegistry(tmp_path / "registry")
  manifest = _manifest("d" * 64)

  with pytest.raises(ArtifactConflictError, match="missing registry blob"):
    registry.register_manifest(manifest)

  with pytest.raises(ValidationError, match="checksum"):
    CandidateManifest.model_validate(
      {**manifest.model_dump(), "manifest_checksum": "e" * 64}
    )


def test_registry_rejects_public_or_unsafe_artifact_uris():
  with pytest.raises(ValidationError, match="registry URI"):
    ArtifactReference(
      name="report", revision="v1", sha256="f" * 64, uri="https://example.com/report.json"
    )


def test_registry_cli_registers_file_manifest_and_verifies_candidate(tmp_path, capsys):
  registry_root = tmp_path / "registry"
  source = tmp_path / "report.json"
  source.write_text('{"passed":true}\n', encoding="utf-8")
  assert registry_cli([
    "register-file", "--registry", str(registry_root), "--path", str(source),
    "--name", "quality-report", "--revision", "candidate-v1",
  ]) == 0
  reference = ArtifactReference.model_validate_json(capsys.readouterr().out)
  manifest_path = tmp_path / "manifest.json"
  manifest_path.write_text(_manifest(reference.sha256).model_dump_json(indent=2), encoding="utf-8")

  assert registry_cli([
    "register-manifest", "--registry", str(registry_root), "--manifest", str(manifest_path),
  ]) == 0
  capsys.readouterr()
  assert registry_cli([
    "verify", "--registry", str(registry_root), "--candidate-id", "mlops-20260811-test",
  ]) == 0
  assert "manifest_checksum" in capsys.readouterr().out
