#!/usr/bin/env python3
from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
import sys


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.ops.private_rag_activation import (
  ActivationBlocked,
  PrivateRagActivationInputs,
  build_private_rag_activation,
  write_private_rag_activation,
)


def main() -> int:
  parser = argparse.ArgumentParser(
    description="Build one immutable final-SHA private RAG activation receipt."
  )
  parser.add_argument("--approval", type=Path, required=True)
  parser.add_argument("--corpus-manifest", type=Path, required=True)
  parser.add_argument("--corpus-snapshot", type=Path, required=True)
  parser.add_argument("--ragops-report", type=Path, required=True)
  parser.add_argument("--answer-report", type=Path, required=True)
  parser.add_argument("--source-git-sha", required=True)
  parser.add_argument("--git-dirty", action="store_true")
  parser.add_argument("--now", type=datetime.fromisoformat)
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument("--commitment", type=Path, required=True)
  args = parser.parse_args()

  try:
    receipt = build_private_rag_activation(
      PrivateRagActivationInputs(
        approval=args.approval,
        corpus_manifest=args.corpus_manifest,
        corpus_snapshot=args.corpus_snapshot,
        ragops_report=args.ragops_report,
        answer_report=args.answer_report,
        source_git_sha=args.source_git_sha,
        git_dirty=args.git_dirty,
      ),
      now=args.now,
    )
    write_private_rag_activation(receipt, args.output, args.commitment)
  except ActivationBlocked as issue:
    print(f"private-rag-activation-blocked: {issue}", file=sys.stderr)
    return 1

  print(args.commitment.as_posix())
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
