from __future__ import annotations

import argparse
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from qdrant_client import QdrantClient

from app.audit import SqliteAuditSink

from ..config import load_settings
from .bootstrap import is_private_service_url
from .collections import QdrantCollectionManager
from .migration import LlamaIndexCutoverController


def _load_audit_sink(args: argparse.Namespace | SimpleNamespace) -> SqliteAuditSink | None:
  values = (args.audit_database, args.audit_key_file, args.release_sha)
  if not any(value is not None for value in values):
    if args.apply:
      raise RuntimeError(
        "applied cutover/rollback requires --audit-database, --audit-key-file and --release-sha"
      )
    return None
  if not all(value is not None for value in values):
    raise RuntimeError("audit configuration must be supplied as one complete set")
  if args.audit_key_file.stat().st_mode & 0o077:
    raise RuntimeError("audit key file permissions must be 0600")
  key = args.audit_key_file.read_bytes()
  if len(key) < 32:
    raise RuntimeError("audit key must contain at least 32 bytes")
  return SqliteAuditSink(args.audit_database, hmac_key=key)


def main() -> int:
  parser = argparse.ArgumentParser(description="Guarded LlamaIndex Qdrant alias cutover or rollback")
  parser.add_argument("action", choices=("status", "cutover", "rollback"))
  parser.add_argument("--legacy-collection", required=True)
  parser.add_argument("--candidate-collection", required=True)
  parser.add_argument("--vector-size", type=int, required=True)
  parser.add_argument("--apply", action="store_true")
  parser.add_argument("--audit-database", type=Path)
  parser.add_argument("--audit-key-file", type=Path)
  parser.add_argument("--release-sha")
  parser.add_argument("--actor-id", default="rag-cutover-operator")
  parser.add_argument("--request-id")
  args = parser.parse_args()
  settings = load_settings()
  if not is_private_service_url(settings.qdrant_url):
    raise SystemExit("cutover requires a private Qdrant endpoint")
  if args.candidate_collection != settings.llamaindex_candidate_collection:
    raise SystemExit("candidate collection must match LLAMAINDEX_CANDIDATE_COLLECTION")
  audit_sink = _load_audit_sink(args)
  client = None
  try:
    client = QdrantClient(
      url=settings.qdrant_url,
      api_key=settings.qdrant_api_key,
      timeout=10,
    )
    manager = QdrantCollectionManager(
      client,
      alias=settings.qdrant_collection_alias,
      vector_size=args.vector_size,
    )
    controller = LlamaIndexCutoverController(
      manager,
      legacy_collection=args.legacy_collection,
      candidate_collection=args.candidate_collection,
    )
    before = manager.active_collection()
    if args.action == "status":
      result = {
        "action": args.action,
        "applied": False,
        "active_collection": before,
      }
    elif not args.apply:
      result = {
        "action": args.action,
        "applied": False,
        **controller.preflight(args.action),
      }
    else:
      if audit_sink is None or args.release_sha is None:
        raise RuntimeError("durable audit is required for an applied alias transition")
      transition = controller.apply_audited(
        args.action,
        audit_sink=audit_sink,
        release_sha=args.release_sha,
        actor_id=args.actor_id,
        request_id=args.request_id or f"rag-cutover-{uuid4().hex}",
      )
      result = {
        "action": args.action,
        "applied": True,
        **transition,
      }
    print(json.dumps(result, sort_keys=True))
    return 0
  finally:
    if client is not None:
      client.close()
    if audit_sink is not None:
      audit_sink.close()


if __name__ == "__main__":
  raise SystemExit(main())
