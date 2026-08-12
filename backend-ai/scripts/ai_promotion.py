#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from functools import partial
import sys
from types import SimpleNamespace

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.artifacts.registry import ImmutableArtifactRegistry
from app.audit import SqliteAuditSink
from app.ops.promotion import PromotionBlocked, PromotionController, verify_hmac_approval


def _load_audit_sink(args: argparse.Namespace | SimpleNamespace) -> SqliteAuditSink | None:
  values = (args.audit_database, args.audit_key_file, args.release_sha)
  if not any(value is not None for value in values):
    if args.apply:
      raise PromotionBlocked(
        "applied rollout/rollback requires --audit-database, --audit-key-file and --release-sha"
      )
    return None
  if not all(value is not None for value in values):
    raise PromotionBlocked("audit configuration must be supplied as one complete set")
  if args.audit_key_file.stat().st_mode & 0o077:
    raise PromotionBlocked("audit key file permissions must be 0600")
  audit_key = args.audit_key_file.read_bytes()
  if len(audit_key) < 32:
    raise PromotionBlocked("audit key must contain at least 32 bytes")
  return SqliteAuditSink(args.audit_database, hmac_key=audit_key)


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
  parser.add_argument("--audit-database", type=Path)
  parser.add_argument("--audit-key-file", type=Path)
  parser.add_argument("--release-sha")
  parser.add_argument("--actor-id", default="rollout-operator")
  parser.add_argument("--request-id")
  args = parser.parse_args()
  registry = ImmutableArtifactRegistry(args.registry)
  audit_sink = None
  try:
    approval_verifier = None
    if args.approval_key_file is not None:
      if args.approval_key_file.stat().st_mode & 0o077:
        raise PromotionBlocked("approval key file permissions must be 0600")
      approval_key = args.approval_key_file.read_bytes()
      if len(approval_key) < 32:
        raise PromotionBlocked("approval verification key must contain at least 32 bytes")
      approval_verifier = partial(verify_hmac_approval, key=approval_key)
    audit_sink = _load_audit_sink(args)
    controller = PromotionController(
      args.pointer_root,
      candidate_verifier=registry.verify_manifest,
      approval_verifier=approval_verifier,
      audit_sink=audit_sink,
      release_sha=args.release_sha,
    )
    if args.rollback:
      if not args.apply:
        raise PromotionBlocked("rollback requires explicit --apply")
      result = controller.rollback(actor_id=args.actor_id, request_id=args.request_id)
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
        request_id=args.request_id,
      )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0
  except (PromotionBlocked, OSError, ValueError, json.JSONDecodeError) as issue:
    print(f"promotion-blocked: {issue}", file=sys.stderr)
    return 2
  finally:
    if audit_sink is not None:
      audit_sink.close()


if __name__ == "__main__":
  raise SystemExit(main())
