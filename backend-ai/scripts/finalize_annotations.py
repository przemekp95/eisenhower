#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from typing import Any
import argparse
import hashlib
import json
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.evaluation import finalize_dual_annotations


def load_jsonl(path: Path) -> list[dict[str, Any]]:
  rows: list[dict[str, Any]] = []
  for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
    if not raw_line.strip():
      continue
    row = json.loads(raw_line)
    if not isinstance(row, dict):
      raise ValueError(f"{path}:{line_number} must contain a JSON object.")
    rows.append(row)
  if not rows:
    raise ValueError(f"{path} is empty.")
  return rows


def load_decisions(path: Path) -> dict[str, int]:
  decisions: dict[str, int] = {}
  for row in load_jsonl(path):
    example_id = str(row.get("id", "")).strip()
    quadrant = row.get("quadrant")
    if not example_id or example_id in decisions:
      raise ValueError(f"{path} must contain unique non-empty ids.")
    if not isinstance(quadrant, int) or isinstance(quadrant, bool) or quadrant not in range(4):
      raise ValueError(f"{path}:{example_id} requires a human quadrant integer in range 0..3.")
    decisions[example_id] = quadrant
  return decisions


def sha256(path: Path) -> str:
  return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
  parser = argparse.ArgumentParser(
    description="Measure two blind human annotations and build a pending evaluation candidate."
  )
  parser.add_argument("--pool", type=Path, required=True)
  parser.add_argument("--annotator-a", type=Path, required=True)
  parser.add_argument("--annotator-b", type=Path, required=True)
  parser.add_argument("--adjudication", type=Path)
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument("--dataset-name", required=True)
  args = parser.parse_args()

  try:
    pool = load_jsonl(args.pool)
    annotator_a = load_decisions(args.annotator_a)
    annotator_b = load_decisions(args.annotator_b)
    adjudication = load_decisions(args.adjudication) if args.adjudication else {}
    candidate = finalize_dual_annotations(
      pool,
      annotator_a,
      annotator_b,
      adjudication=adjudication,
      dataset_name=args.dataset_name,
      annotator_a_sha256=sha256(args.annotator_a),
      annotator_b_sha256=sha256(args.annotator_b),
      pool_sha256=sha256(args.pool),
    )
  except (OSError, ValueError, json.JSONDecodeError) as issue:
    print(f"annotation-finalization-blocked: {issue}", file=sys.stderr)
    return 2

  serialized = json.dumps(candidate, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
  args.output.parent.mkdir(parents=True, exist_ok=True)
  args.output.write_text(serialized, encoding="utf-8")
  evidence = candidate["governance"]["annotation_evidence"]
  print(
    json.dumps(
      {
        "status": candidate["governance"]["status"],
        "output": str(args.output),
        "examples": len(candidate["examples"]),
        "raw_agreement": evidence["raw_agreement"],
        "cohen_kappa": evidence["cohen_kappa"],
        "disagreements": len(evidence["disagreement_ids"]),
      },
      ensure_ascii=False,
    )
  )
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
