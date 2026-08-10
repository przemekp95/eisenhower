#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import argparse
import hashlib
import json
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.evaluation import evaluation_governance_issues, freeze_evaluation_candidate


def main() -> int:
  parser = argparse.ArgumentParser(
    description="Freeze a measured candidate after an explicit named human approval."
  )
  parser.add_argument("--input", type=Path, required=True)
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument("--manifest", type=Path, required=True)
  parser.add_argument("--approver-id", required=True)
  parser.add_argument("--approved-at", required=True, help="Human approval timestamp, preferably ISO-8601 UTC.")
  args = parser.parse_args()

  try:
    candidate = json.loads(args.input.read_text(encoding="utf-8"))
    frozen = freeze_evaluation_candidate(
      candidate,
      approver_id=args.approver_id,
      approved_at=args.approved_at,
    )
    governance_issues = evaluation_governance_issues(frozen, profile="production")
    if governance_issues:
      raise ValueError(f"production governance issues remain: {governance_issues}")
  except (OSError, ValueError, json.JSONDecodeError) as issue:
    print(f"evaluation-freeze-blocked: {issue}", file=sys.stderr)
    return 2

  serialized = json.dumps(frozen, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
  digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
  manifest = {
    "dataset_name": frozen["name"],
    "dataset_sha256": digest,
    "examples": len(frozen["examples"]),
    "approved_by": frozen["governance"]["approved_by"],
    "approved_at": frozen["governance"]["approved_at"],
    "label_contract": frozen["label_contract"],
  }
  args.output.parent.mkdir(parents=True, exist_ok=True)
  args.manifest.parent.mkdir(parents=True, exist_ok=True)
  args.output.write_text(serialized, encoding="utf-8")
  args.manifest.write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
  )
  print(json.dumps({"status": "approved-frozen", **manifest}, ensure_ascii=False))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
