#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.artifacts.registry import ImmutableArtifactRegistry
from app.ops.promotion import PromotionBlocked, PromotionController


def main() -> int:
  parser = argparse.ArgumentParser(
    description="Dry-run or explicitly apply an atomic AI phase transition. Dry-run is the default."
  )
  parser.add_argument("--pointer-root", type=Path, required=True)
  parser.add_argument("--registry", type=Path, required=True)
  parser.add_argument("--phase", choices=("retrieval", "generation", "response", "mag"))
  parser.add_argument("--target-mode", choices=("shadow", "canary", "enabled"))
  parser.add_argument("--candidate-id")
  parser.add_argument("--canary-percent", type=int, default=0)
  parser.add_argument("--quality-report", type=Path)
  parser.add_argument("--approval", type=Path)
  parser.add_argument("--apply", action="store_true", help="Write the local pointer; never deploys.")
  parser.add_argument("--rollback", action="store_true")
  args = parser.parse_args()
  registry = ImmutableArtifactRegistry(args.registry)
  controller = PromotionController(
    args.pointer_root,
    candidate_verifier=registry.verify_manifest,
  )
  try:
    if args.rollback:
      if not args.apply:
        raise PromotionBlocked("rollback requires explicit --apply")
      result = controller.rollback()
    else:
      if not all((args.phase, args.target_mode, args.candidate_id, args.quality_report, args.approval)):
        raise PromotionBlocked("transition arguments are incomplete")
      result = controller.transition(
        phase=args.phase,
        target_mode=args.target_mode,
        candidate_id=args.candidate_id,
        canary_percent=args.canary_percent,
        quality_report=json.loads(args.quality_report.read_text(encoding="utf-8")),
        approval=json.loads(args.approval.read_text(encoding="utf-8")),
        dry_run=not args.apply,
      )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0
  except (PromotionBlocked, OSError, ValueError, json.JSONDecodeError) as issue:
    print(f"promotion-blocked: {issue}", file=sys.stderr)
    return 2


if __name__ == "__main__":
  raise SystemExit(main())
