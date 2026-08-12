#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.artifacts.registry import write_private_bytes
from app.generation.registry import PromptRegistry
from app.generation.renderer import HuggingFaceTokenCounter, PromptRenderer
from app.rag.adapters import OpenAICompatibleGenerationProvider
from app.rag.knowledge_answer_holdout import run_knowledge_answer_holdout_files


def _provider(args):
  registry = PromptRegistry.load_directory(args.prompt_dir)
  reference = registry.get("knowledge-answer", "1.0.0", "en")
  renderer = PromptRenderer(HuggingFaceTokenCounter.from_prompt_spec(reference))
  return OpenAICompatibleGenerationProvider(
    base_url=args.base_url,
    allowed_hosts=tuple(args.allowed_host),
    api_key=args.api_key,
    prompt_registry=registry,
    prompt_renderer=renderer,
    prompt_id="eisenhower-classifier",
    prompt_version="1.0.0",
    knowledge_prompt_id="knowledge-answer",
    knowledge_prompt_version="1.0.0",
    connect_timeout_seconds=5.0,
    read_timeout_seconds=30.0,
    write_timeout_seconds=5.0,
    pool_timeout_seconds=2.0,
  )


def main() -> int:
  parser = argparse.ArgumentParser(
    description="Run the sealed deterministic knowledge-answer holdout once."
  )
  parser.add_argument(
    "--dataset", type=Path,
    default=PROJECT_ROOT / "evaluation" / "knowledge-answer-v1" / "holdout.jsonl",
  )
  parser.add_argument(
    "--policy", type=Path,
    default=PROJECT_ROOT / "evaluation" / "knowledge-answer-v1" / "policy.json",
  )
  parser.add_argument(
    "--prompt-dir", type=Path, default=PROJECT_ROOT / "prompts",
  )
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument("--candidate-id", required=True)
  parser.add_argument("--git-sha", required=True)
  parser.add_argument(
    "--base-url", default=os.environ.get("INFERENCE_BASE_URL", "http://127.0.0.1:8000/v1")
  )
  parser.add_argument("--api-key", default=os.environ.get("INFERENCE_API_KEY", ""))
  parser.add_argument("--allowed-host", action="append", default=[])
  parser.add_argument("--evidence-level", default="physical_local_amd_runtime_holdout")
  args = parser.parse_args()
  if not args.api_key:
    parser.error("--api-key or INFERENCE_API_KEY is required")
  try:
    report = run_knowledge_answer_holdout_files(
      args.dataset,
      args.policy,
      generator=_provider(args),
      candidate_id=args.candidate_id,
      evidence_level=args.evidence_level,
      git_sha=args.git_sha,
    )
    write_private_bytes(
      args.output,
      (json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode(),
    )
  except (OSError, ValueError, json.JSONDecodeError) as issue:
    print(f"knowledge-answer-holdout-blocked: {issue}", file=sys.stderr)
    return 2
  print(json.dumps({
    "status": report["status"],
    "cases": report["metrics"]["cases"],
    "passed": report["metrics"]["passed"],
    "failed_gates": report["failed_gates"],
    "report_checksum": report["report_checksum"],
  }, sort_keys=True))
  return 0 if report["status"] == "green" else 2


if __name__ == "__main__":
  raise SystemExit(main())
