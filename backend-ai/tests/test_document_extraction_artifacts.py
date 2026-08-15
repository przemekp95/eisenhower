from hashlib import sha256
import json

import pytest

from app.document_extraction.adapters import resolve_docling_artifacts
from app.document_extraction.artifacts import (
  ArtifactBundleRejected,
  build_artifact_manifest,
  verify_artifact_bundle,
)


def test_builds_and_verifies_an_exact_regular_file_bundle(tmp_path):
  model = tmp_path / "docling-project--docling-layout-heron-onnx"
  model.mkdir()
  (model / "config.json").write_text("{}", encoding="utf-8")
  (model / "model.onnx").write_bytes(b"onnx")

  manifest = build_artifact_manifest(
    tmp_path,
    repository="docling-project/docling-layout-heron-onnx",
    revision="40bde044036bb181c130ddf6c51792187268748f",
  )
  manifest_path = tmp_path / "manifest.json"
  manifest_path.write_text(
    json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
  )
  digest = sha256(manifest_path.read_bytes()).hexdigest()

  assert verify_artifact_bundle(
    tmp_path,
    expected_manifest_sha256=digest,
    expected_repository="docling-project/docling-layout-heron-onnx",
    expected_revision="40bde044036bb181c130ddf6c51792187268748f",
  ) == tmp_path


def test_rejects_manifest_tampering_missing_files_and_unlisted_files(tmp_path):
  model = tmp_path / "repo--model"
  model.mkdir()
  (model / "model.onnx").write_bytes(b"onnx")
  manifest = build_artifact_manifest(tmp_path, repository="repo/model", revision="abc123")
  manifest_path = tmp_path / "manifest.json"
  manifest_path.write_text(
    json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
  )
  digest = sha256(manifest_path.read_bytes()).hexdigest()

  (model / "model.onnx").write_bytes(b"oops")
  with pytest.raises(ArtifactBundleRejected, match="digest"):
    verify_artifact_bundle(
      tmp_path,
      expected_manifest_sha256=digest,
      expected_repository="repo/model",
      expected_revision="abc123",
    )

  (model / "model.onnx").write_bytes(b"onnx")
  (model / "unexpected.bin").write_bytes(b"unexpected")
  with pytest.raises(ArtifactBundleRejected, match="file set"):
    verify_artifact_bundle(
      tmp_path,
      expected_manifest_sha256=digest,
      expected_repository="repo/model",
      expected_revision="abc123",
    )


def test_rejects_symlinks_from_the_offline_bundle(tmp_path):
  model = tmp_path / "repo--model"
  model.mkdir()
  target = model / "model.onnx"
  target.write_bytes(b"onnx")
  (model / "alias.onnx").symlink_to(target)

  with pytest.raises(ArtifactBundleRejected, match="regular files"):
    build_artifact_manifest(tmp_path, repository="repo/model", revision="abc123")


def test_production_requires_the_verified_offline_bundle(tmp_path):
  with pytest.raises(ArtifactBundleRejected, match="required in production"):
    resolve_docling_artifacts({"APP_ENV": "production"})

  assert resolve_docling_artifacts({"APP_ENV": "development"}) is None

  model = tmp_path / "docling-project--docling-layout-heron-onnx"
  model.mkdir()
  (model / "model.onnx").write_bytes(b"onnx")
  manifest = build_artifact_manifest(
    tmp_path,
    repository="docling-project/docling-layout-heron-onnx",
    revision="40bde044036bb181c130ddf6c51792187268748f",
  )
  manifest_path = tmp_path / "manifest.json"
  manifest_path.write_text(
    json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
  )

  assert resolve_docling_artifacts({
    "APP_ENV": "production",
    "DOCLING_ARTIFACTS_PATH": str(tmp_path),
    "DOCLING_ARTIFACTS_MANIFEST_SHA256": sha256(manifest_path.read_bytes()).hexdigest(),
  }) == tmp_path.resolve()
