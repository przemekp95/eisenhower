#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = PROJECT_ROOT.parent
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.rag.corpus_manifest import refresh_manifest_snapshot


def main() -> int:
  parser = argparse.ArgumentParser(
    description="Rebind an existing repository corpus allowlist to current source bytes."
  )
  parser.add_argument(
    "--manifest",
    type=Path,
    default=REPOSITORY_ROOT / "docs/ai-rebuild/corpus-manifest-v1.json",
  )
  parser.add_argument("--check", action="store_true")
  args = parser.parse_args()

  refreshed = refresh_manifest_snapshot(REPOSITORY_ROOT, args.manifest)
  rendered = json.dumps(refreshed, ensure_ascii=False, indent=2) + "\n"
  if args.check:
    if args.manifest.read_text(encoding="utf-8") != rendered:
      raise SystemExit("corpus manifest snapshot is stale")
  else:
    args.manifest.write_text(rendered, encoding="utf-8")
  print(json.dumps({
    "document_count": refreshed["initial_snapshot"]["document_count"],
    "snapshot_sha256": refreshed["initial_snapshot"]["sha256"],
  }))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
