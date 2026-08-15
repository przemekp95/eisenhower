#!/usr/bin/env python3
from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import shutil
import sys
import tempfile

from huggingface_hub import snapshot_download

from app.document_extraction.adapters import (
  DOCLING_LAYOUT_MODEL_REPOSITORY,
  DOCLING_LAYOUT_MODEL_REVISION,
  DOCLING_TABLE_MODEL_REPOSITORY,
  DOCLING_TABLE_MODEL_REVISION,
)
from app.document_extraction.artifacts import build_artifact_manifest


def _copy_snapshot(
  output: Path,
  *,
  repository: str,
  revision: str,
  allow_patterns: list[str] | None = None,
) -> None:
  snapshot = Path(snapshot_download(
    repo_id=repository,
    revision=revision,
    allow_patterns=allow_patterns,
  )).resolve()
  if snapshot.name != revision:
    raise RuntimeError("Hugging Face did not resolve the exact pinned Docling revision")

  model_directory = output / repository.replace("/", "--")
  model_directory.mkdir()
  for source in sorted(snapshot.rglob("*")):
    if not source.is_file():
      continue
    relative = source.relative_to(snapshot)
    destination = model_directory / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source.resolve(strict=True), destination)


def prepare(output: Path) -> dict:
  resolved = output.resolve()
  if resolved.exists() and any(resolved.iterdir()):
    raise RuntimeError("Refusing to overwrite a non-empty Docling artifact directory")
  resolved.mkdir(parents=True, exist_ok=True)
  repositories = {
    DOCLING_LAYOUT_MODEL_REPOSITORY: DOCLING_LAYOUT_MODEL_REVISION,
    DOCLING_TABLE_MODEL_REPOSITORY: DOCLING_TABLE_MODEL_REVISION,
  }
  _copy_snapshot(
    resolved,
    repository=DOCLING_LAYOUT_MODEL_REPOSITORY,
    revision=DOCLING_LAYOUT_MODEL_REVISION,
  )
  _copy_snapshot(
    resolved,
    repository=DOCLING_TABLE_MODEL_REPOSITORY,
    revision=DOCLING_TABLE_MODEL_REVISION,
    allow_patterns=["model_artifacts/tableformer/**"],
  )

  manifest = build_artifact_manifest(
    resolved,
    repositories=repositories,
  )
  manifest_path = resolved / "manifest.json"
  with tempfile.NamedTemporaryFile(
    mode="w",
    encoding="utf-8",
    dir=resolved,
    prefix=".manifest.",
    delete=False,
  ) as handle:
    json.dump(manifest, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
    temporary = Path(handle.name)
  temporary.replace(manifest_path)
  return {
    "path": str(resolved),
    "repositories": repositories,
    "manifest_sha256": sha256(manifest_path.read_bytes()).hexdigest(),
    "files": len(manifest["files"]),
    "size_bytes": sum(record["size_bytes"] for record in manifest["files"].values()),
  }


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--output", type=Path, required=True)
  args = parser.parse_args()
  print(json.dumps(prepare(args.output), indent=2, sort_keys=True))
  return 0


if __name__ == "__main__":
  sys.exit(main())
