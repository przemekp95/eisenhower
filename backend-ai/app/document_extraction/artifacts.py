from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
import re
from typing import Any, Mapping


SCHEMA_VERSION = "docling-offline-artifact-v2"
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")


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


def _repository_files(root: Path, repository: str) -> dict[str, Path]:
  model_directory = _model_directory(root, repository)
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


def _regular_files(root: Path, repositories: Mapping[str, str]) -> dict[str, Path]:
  files: dict[str, Path] = {}
  for repository in sorted(repositories):
    repository_files = _repository_files(root, repository)
    overlap = set(files).intersection(repository_files)
    if overlap:
      raise ArtifactBundleRejected("artifact repositories contain overlapping paths")
    files.update(repository_files)
  return files


def _validate_repositories(repositories: Mapping[str, str]) -> dict[str, str]:
  if not repositories:
    raise ArtifactBundleRejected("artifact repository set is empty")
  normalized: dict[str, str] = {}
  for repository, revision in repositories.items():
    _model_directory(Path("/"), repository)
    if COMMIT_PATTERN.fullmatch(revision) is None:
      raise ArtifactBundleRejected("artifact revision must be an immutable commit SHA")
    normalized[repository] = revision
  return dict(sorted(normalized.items()))


def build_artifact_manifest(
  root: Path,
  *,
  repositories: Mapping[str, str],
) -> dict[str, Any]:
  resolved = root.resolve()
  approved = _validate_repositories(repositories)
  files = _regular_files(resolved, approved)
  return {
    "schema_version": SCHEMA_VERSION,
    "repositories": approved,
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
  expected_repositories: Mapping[str, str],
) -> Path:
  resolved = root.resolve()
  approved = _validate_repositories(expected_repositories)
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
    manifest.get("repositories") != approved,
    not isinstance(manifest.get("files"), dict),
  )):
    raise ArtifactBundleRejected("artifact manifest identity does not match runtime")

  actual = _regular_files(resolved, approved)
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
