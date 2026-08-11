#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from functools import partial
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.artifacts.registry import ImmutableArtifactRegistry
from app.ops.promotion import PromotionBlocked, PromotionController, verify_hmac_approval


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
  parser.add_argument(
    "--approval-key-file", type=Path,
    help="0600 file containing the out-of-band owner approval verification key.",
  )
  parser.add_argument("--apply", action="store_true", help="Write the local pointer; never deploys.")
  parser.add_argument("--rollback", action="store_true")
  args = parser.parse_args()
  registry = ImmutableArtifactRegistry(args.registry)
  try:
    approval_verifier = None
    if args.approval_key_file is not None:
      if args.approval_key_file.stat().st_mode & 0o077:
        raise PromotionBlocked("approval key file permissions must be 0600")
      approval_key = args.approval_key_file.read_bytes()
      if len(approval_key) < 32:
        raise PromotionBlocked("approval verification key must contain at least 32 bytes")
      approval_verifier = partial(verify_hmac_approval, key=approval_key)
    controller = PromotionController(
      args.pointer_root,
      candidate_verifier=registry.verify_manifest,
      approval_verifier=approval_verifier,
    )
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
