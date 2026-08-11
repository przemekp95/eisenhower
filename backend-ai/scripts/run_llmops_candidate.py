#!/usr/bin/env python3
from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.artifacts.registry import ImmutableArtifactRegistry
from app.generation.models import ClassificationOutput, PromptSpec
from app.ops.candidates import CandidateWorkflowError, register_llmops_candidate


def _contract_report(golden_path: Path, prompt_paths: list[Path]) -> dict:
  cases = [json.loads(line) for line in golden_path.read_text(encoding="utf-8").splitlines() if line]
  languages = {case["language"] for case in cases}
  tags = {tag for case in cases for tag in case.get("tags", [])}
  specs = [PromptSpec.model_validate_json(path.read_text(encoding="utf-8")) for path in prompt_paths]
  passed = languages == {"pl", "en"} and "prompt-injection" in tags and all(
    spec.verify_checksum() for spec in specs
  )
  baseline = sha256(golden_path.read_bytes()).hexdigest()
  return {
    "evidence_level": "ci_in_process",
    "evidence_scope": "static PromptSpec, token-budget, fixture and schema contracts; no model executed",
    "languages": {language: {"passed": language in languages} for language in ("pl", "en")},
    "safety": {
      "prompt_injection": {"passed": "prompt-injection" in tags},
      "citation_fabrication": {"passed": any(case.get("allowed_citation_ids") == [] for case in cases)},
    },
    "structured_output": {"passed": bool(ClassificationOutput.model_json_schema()), "schema_rejections": 0},
    "regression": {"passed": passed, "champion_checksum": baseline},
    "live_model": {"executed": False, "passed": False},
    "candidate_gate": {"passed": passed, "reasons": [] if passed else ["contract coverage incomplete"]},
  }


def main() -> int:
  parser = argparse.ArgumentParser(description="Create an in-process, non-live LLMOps candidate.")
  parser.add_argument("--registry", type=Path, required=True)
  parser.add_argument("--candidate-id", required=True)
  parser.add_argument("--git-sha", required=True)
  parser.add_argument("--git-dirty", action="store_true")
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument("--golden", type=Path, default=PROJECT_ROOT / "evaluation" / "golden-v1.jsonl")
  parser.add_argument(
    "--prompts", type=Path, nargs=2,
    default=[
      PROJECT_ROOT / "prompts" / "eisenhower-classifier" / "1.0.0" / "pl.json",
      PROJECT_ROOT / "prompts" / "eisenhower-classifier" / "1.0.0" / "en.json",
    ],
  )
  args = parser.parse_args()
  schema_path = args.output.parent / "classification-output-schema.json"
  try:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    schema_path.write_text(
      json.dumps(ClassificationOutput.model_json_schema(), indent=2, sort_keys=True) + "\n",
      encoding="utf-8",
    )
    manifest = register_llmops_candidate(
      registry=ImmutableArtifactRegistry(args.registry),
      candidate_id=args.candidate_id,
      git_sha=args.git_sha,
      git_dirty=args.git_dirty,
      prompt_paths=args.prompts,
      schema_path=schema_path,
      golden_path=args.golden,
      report=_contract_report(args.golden, args.prompts),
    )
    args.output.write_text(manifest.model_dump_json(indent=2) + "\n", encoding="utf-8")
    print(manifest.model_dump_json())
    return 0
  except (CandidateWorkflowError, OSError, ValueError, json.JSONDecodeError) as issue:
    print(f"llmops-candidate-blocked: {issue}", file=sys.stderr)
    return 2


if __name__ == "__main__":
  raise SystemExit(main())
