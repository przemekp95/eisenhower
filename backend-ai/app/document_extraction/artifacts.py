from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
import re
from typing import Any


SCHEMA_VERSION = "docling-offline-artifact-v1"
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class ArtifactBundleRejected(RuntimeError):
  """The offline parser model bundle is absent, drifted or malformed."""


def _file_sha256(path: Path) -> str:
  digest = sha256()
  with path.open("rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
      digest.update(chunk)
  return digest.hexdigest()


def _model_directory(root: Path, repository: str) -> Path:
  if repository.count("/") != 1 or any(part in {"", ".", ".."} for part in repository.split("/")):
    raise ArtifactBundleRejected("artifact repository identity is malformed")
  return root / repository.replace("/", "--")


def _regular_files(root: Path, model_directory: Path) -> dict[str, Path]:
  if not model_directory.is_dir():
    raise ArtifactBundleRejected(f"artifact model directory is missing: {model_directory.name}")
  files: dict[str, Path] = {}
  for path in sorted(model_directory.rglob("*")):
    if path.is_symlink() or (path.exists() and not path.is_file() and not path.is_dir()):
      raise ArtifactBundleRejected("artifact bundles may contain regular files only")
    if path.is_file():
      files[path.relative_to(root).as_posix()] = path
  if not files:
    raise ArtifactBundleRejected("artifact model directory contains no files")
  return files


def build_artifact_manifest(
  root: Path,
  *,
  repository: str,
  revision: str,
) -> dict[str, Any]:
  resolved = root.resolve()
  if not revision or any(character.isspace() for character in revision):
    raise ArtifactBundleRejected("artifact revision is malformed")
  files = _regular_files(resolved, _model_directory(resolved, repository))
  return {
    "schema_version": SCHEMA_VERSION,
    "repository": repository,
    "revision": revision,
    "files": {
      relative: {
        "sha256": _file_sha256(path),
        "size_bytes": path.stat().st_size,
      }
      for relative, path in files.items()
    },
  }


def verify_artifact_bundle(
  root: Path,
  *,
  expected_manifest_sha256: str,
  expected_repository: str,
  expected_revision: str,
) -> Path:
  resolved = root.resolve()
  if SHA256_PATTERN.fullmatch(expected_manifest_sha256) is None:
    raise ArtifactBundleRejected("expected artifact manifest digest is malformed")
  manifest_path = resolved / "manifest.json"
  try:
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
  except (OSError, json.JSONDecodeError) as error:
    raise ArtifactBundleRejected("artifact manifest is missing or malformed") from error
  if sha256(manifest_bytes).hexdigest() != expected_manifest_sha256:
    raise ArtifactBundleRejected("artifact manifest digest does not match approval")
  if not isinstance(manifest, dict) or any((
    manifest.get("schema_version") != SCHEMA_VERSION,
    manifest.get("repository") != expected_repository,
    manifest.get("revision") != expected_revision,
    not isinstance(manifest.get("files"), dict),
  )):
    raise ArtifactBundleRejected("artifact manifest identity does not match runtime")

  actual = _regular_files(resolved, _model_directory(resolved, expected_repository))
  declared = manifest["files"]
  if set(actual) != set(declared):
    raise ArtifactBundleRejected("artifact file set does not match the approved manifest")
  for relative, path in actual.items():
    record = declared[relative]
    if not isinstance(record, dict):
      raise ArtifactBundleRejected("artifact file record is malformed")
    if record.get("size_bytes") != path.stat().st_size:
      raise ArtifactBundleRejected(f"artifact size mismatch: {relative}")
    if record.get("sha256") != _file_sha256(path):
      raise ArtifactBundleRejected(f"artifact digest mismatch: {relative}")
  return resolved
