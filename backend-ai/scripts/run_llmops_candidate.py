#!/usr/bin/env python3
from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import sys
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.artifacts.registry import (
  ImmutableArtifactRegistry,
  write_private_bytes,
  write_public_commitment,
)
from app.generation.models import ClassificationOutput, Evidence, Fact, PromptSpec
from app.ops.candidates import CandidateWorkflowError, register_llmops_candidate
from app.rag.golden import load_golden_dataset


def _load_probe_outputs(path: Path) -> dict[str, dict[str, Any]]:
  records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
  required = {"case_id", "status", "urgent", "important", "quadrant", "citations"}
  if not records or any(set(record) != required for record in records):
    raise CandidateWorkflowError("mock output fixture contract is invalid")
  outputs = {str(record["case_id"]): record for record in records}
  if len(outputs) != len(records):
    raise CandidateWorkflowError("mock output fixture case ids must be unique")
  return outputs


def _contract_probe(fixture: dict[str, Any]) -> ClassificationOutput:
  """Validate a frozen mock output through the real schema; no model is executed."""
  if fixture["status"] == "insufficient_evidence":
    return ClassificationOutput(
      status="insufficient_evidence", urgent=None, important=None, quadrant=None,
      facts=[], evidence=[], citations=[], explanation="No grounded evidence in the fixture.",
      confidence=None, no_answer_reason="fixture_requires_no_answer",
    )
  citations = list(fixture["citations"])
  return ClassificationOutput(
    status="classified",
    urgent=fixture["urgent"],
    important=fixture["important"],
    quadrant=fixture["quadrant"],
    facts=[Fact(statement="Synthetic contract probe input", source="task")],
    evidence=[
      Evidence(statement="Synthetic allowlisted contract evidence", source="retrieved_context", chunk_id=item)
      for item in citations
    ],
    citations=citations,
    explanation="Deterministic non-model contract probe.",
    confidence=1.0,
    no_answer_reason=None,
  )


def _contract_report(golden_path: Path, output_path: Path, prompt_paths: list[Path]) -> dict:
  cases = load_golden_dataset(golden_path)
  fixtures = _load_probe_outputs(output_path)
  if set(fixtures) != {case.case_id for case in cases}:
    raise CandidateWorkflowError("mock outputs must match golden case ids exactly")
  languages = {case.language for case in cases}
  tags = {tag for case in cases for tag in case.tags}
  specs = [PromptSpec.model_validate_json(path.read_text(encoding="utf-8")) for path in prompt_paths]
  outputs = [_contract_probe(fixtures[case.case_id]) for case in cases]
  schema_rejections = 0
  exact_matches = sum(
    output.quadrant == case.expected_quadrant
    and (output.status == "insufficient_evidence") == (case.answerability == "no_answer")
    for case, output in zip(cases, outputs, strict=True)
  )
  citations_safe = all(
    set(output.citations).issubset(case.allowed_citation_ids)
    and set(output.citations).isdisjoint(case.forbidden_citation_ids)
    for case, output in zip(cases, outputs, strict=True)
  )
  injection_cases = sum("prompt-injection" in case.tags for case in cases)
  prompt_contracts_passed = all(spec.verify_checksum() for spec in specs)
  passed = (
    languages == {"pl", "en"}
    and injection_cases > 0
    and prompt_contracts_passed
    and citations_safe
    and exact_matches == len(cases)
  )
  baseline = sha256(output_path.read_bytes()).hexdigest()
  return {
    "evidence_level": "ci_in_process",
    "evidence_scope": "deterministic non-model golden contract probe plus PromptSpec and schema validation",
    "probe_kind": "frozen_mock_outputs_not_live_model",
    "golden_checksum": sha256(golden_path.read_bytes()).hexdigest(),
    "languages": {
      language: {
        "passed": language in languages and all(
          output.quadrant == case.expected_quadrant
          for case, output in zip(cases, outputs, strict=True) if case.language == language
        ),
        "cases": sum(case.language == language for case in cases),
      }
      for language in ("pl", "en")
    },
    "safety": {
      "prompt_injection": {"passed": injection_cases > 0 and citations_safe, "cases": injection_cases},
      "citation_fabrication": {"passed": citations_safe, "cases": len(cases)},
    },
    "structured_output": {
      "passed": bool(ClassificationOutput.model_json_schema()) and schema_rejections == 0,
      "validated_cases": len(outputs), "schema_rejections": schema_rejections,
    },
    "regression": {
      "passed": exact_matches == len(cases), "cases": len(cases),
      "exact_matches": exact_matches, "champion_checksum": baseline,
    },
    "prompt_contracts": {"passed": prompt_contracts_passed, "count": len(specs)},
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
    "--outputs", type=Path,
    default=PROJECT_ROOT / "evaluation" / "golden-mock-outputs-v1.jsonl",
  )
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
    write_private_bytes(
      schema_path,
      (json.dumps(ClassificationOutput.model_json_schema(), indent=2, sort_keys=True) + "\n").encode(),
    )
    manifest = register_llmops_candidate(
      registry=ImmutableArtifactRegistry(args.registry),
      candidate_id=args.candidate_id,
      git_sha=args.git_sha,
      git_dirty=args.git_dirty,
      prompt_paths=args.prompts,
      schema_path=schema_path,
      golden_path=args.golden,
      output_path=args.outputs,
      report=_contract_report(args.golden, args.outputs, args.prompts),
    )
    write_private_bytes(args.output, (manifest.model_dump_json(indent=2) + "\n").encode())
    write_public_commitment(manifest, args.output.with_name("llmops-commitment.json"))
    print(json.dumps({"candidate_id": manifest.candidate_id, "manifest_checksum": manifest.manifest_checksum}))
    return 0
  except (CandidateWorkflowError, OSError, ValueError, json.JSONDecodeError) as issue:
    print(f"llmops-candidate-blocked: {issue}", file=sys.stderr)
    return 2


if __name__ == "__main__":
  raise SystemExit(main())
