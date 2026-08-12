#!/usr/bin/env python3
from __future__ import annotations

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import tempfile

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.rag.human_review import (
  build_review_template,
  finalize_human_review,
  serialize_dataset,
)


def _write_new(path: Path, content: str) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  with path.open("x", encoding="utf-8") as target:
    target.write(content)


def _stage_file(path: Path, content: str) -> Path:
  path.parent.mkdir(parents=True, exist_ok=True)
  descriptor, temporary = tempfile.mkstemp(
    dir=path.parent,
    prefix=f".{path.name}.pending-",
  )
  staged = Path(temporary)
  try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as target:
      target.write(content)
      target.flush()
      os.fsync(target.fileno())
  except BaseException:
    staged.unlink(missing_ok=True)
    raise
  return staged


def _sync_directory(path: Path) -> None:
  descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
  try:
    os.fsync(descriptor)
  finally:
    os.close(descriptor)


def _write_frozen_pair(
  dataset_path: Path,
  dataset_content: str,
  manifest_path: Path,
  manifest_content: str,
) -> None:
  if manifest_path.exists():
    raise ValueError("frozen approval manifest already exists; refusing to overwrite evidence")
  if dataset_path.exists():
    if dataset_path.read_text(encoding="utf-8") != dataset_content:
      raise ValueError("orphan frozen dataset differs from the validated review output")
    staged_manifest = _stage_file(manifest_path, manifest_content)
    try:
      os.link(staged_manifest, manifest_path)
      _sync_directory(manifest_path.parent)
    finally:
      staged_manifest.unlink(missing_ok=True)
    return

  staged_dataset = _stage_file(dataset_path, dataset_content)
  try:
    staged_manifest = _stage_file(manifest_path, manifest_content)
  except BaseException:
    staged_dataset.unlink(missing_ok=True)
    raise
  dataset_committed = False
  try:
    os.link(staged_dataset, dataset_path)
    dataset_committed = True
    os.link(staged_manifest, manifest_path)
    _sync_directory(dataset_path.parent)
    if manifest_path.parent != dataset_path.parent:
      _sync_directory(manifest_path.parent)
  except BaseException:
    if dataset_committed and dataset_path.exists() and os.path.samefile(staged_dataset, dataset_path):
      dataset_path.unlink()
    raise
  finally:
    staged_dataset.unlink(missing_ok=True)
    staged_manifest.unlink(missing_ok=True)


def main() -> int:
  parser = argparse.ArgumentParser(
    description="Initialize or finalize the independent TASK-013 retrieval review."
  )
  parser.add_argument("--candidate", type=Path, required=True)
  parser.add_argument("--thresholds", type=Path, required=True)
  parser.add_argument("--corpus-manifest", type=Path, required=True)
  parser.add_argument("--review", type=Path, required=True)
  parser.add_argument("--initialize", action="store_true")
  parser.add_argument("--output-dataset", type=Path)
  parser.add_argument("--output-manifest", type=Path)
  args = parser.parse_args()

  try:
    if args.initialize:
      if args.output_dataset or args.output_manifest:
        raise ValueError("initialize does not accept frozen output paths")
      if args.review.exists():
        raise ValueError("review file already exists; refusing to overwrite human work")
      template = build_review_template(args.candidate, args.thresholds, args.corpus_manifest)
      _write_new(
        args.review,
        json.dumps(template, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
      )
      print(json.dumps({"status": "human-review-template-created", "review": str(args.review)}))
      return 0

    if args.output_dataset is None or args.output_manifest is None:
      raise ValueError("finalize requires --output-dataset and --output-manifest")
    if args.output_dataset.resolve() == args.output_manifest.resolve():
      raise ValueError("dataset and approval manifest outputs must be different files")
    cases, approval = finalize_human_review(
      args.candidate,
      args.thresholds,
      args.corpus_manifest,
      args.review,
    )
    serialized = serialize_dataset(cases)
    if sha256(serialized.encode("utf-8")).hexdigest() != approval["dataset_sha256"]:
      raise ValueError("frozen dataset checksum changed during serialization")
    _write_frozen_pair(
      args.output_dataset,
      serialized,
      args.output_manifest,
      json.dumps(approval, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )
    print(
      json.dumps(
        {
          "status": approval["approval_status"],
          "dataset": str(args.output_dataset),
          "dataset_sha256": approval["dataset_sha256"],
          "case_count": approval["case_count"],
        }
      )
    )
    return 0
  except (OSError, ValueError, json.JSONDecodeError) as error:
    print(f"retrieval-review-blocked: {error}", file=sys.stderr)
    return 2


if __name__ == "__main__":
  raise SystemExit(main())
