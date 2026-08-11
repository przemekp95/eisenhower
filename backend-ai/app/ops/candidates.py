from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256
import json
import platform
from pathlib import Path
from typing import Any

from app.artifacts.models import CandidateManifest, GitLineage, LineageGroup, RuntimeLineage
from app.artifacts.registry import ImmutableArtifactRegistry
from app.generation.models import PromptSpec


class CandidateWorkflowError(RuntimeError):
  """Raised when candidate evidence is incomplete or a workflow changes promotion state."""


def _json_bytes(payload: Any) -> bytes:
  return (json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _validate_mlops_report(report: dict[str, Any]) -> None:
  try:
    held_out = report["held_out_evaluation"]
    seeds = {int(item["seed"]) for item in held_out["multi_seed"]}
    languages = set(held_out["mlp"]["by_language"])
    required = (
      held_out["centroid"],
      held_out["incumbent"],
      report["semantic_leakage"],
      report["development_promotion_gate"]["passed"],
      report["production_readiness"]["passed"],
    )
  except (KeyError, TypeError, ValueError) as issue:
    raise CandidateWorkflowError("MLOps candidate evidence is incomplete") from issue
  if any(value is None for value in required):
    raise CandidateWorkflowError("MLOps candidate evidence is incomplete")
  if seeds != {7, 19, 31, 43, 59} or not {"pl", "en"}.issubset(languages):
    raise CandidateWorkflowError("MLOps candidate evidence lacks required seeds or PL/EN slices")
  if report["development_promotion_gate"]["passed"] is not True:
    raise CandidateWorkflowError("MLOps candidate evidence failed the development thresholds")


def register_mlops_candidate(
  *,
  registry: ImmutableArtifactRegistry,
  candidate_id: str,
  git_sha: str,
  git_dirty: bool,
  training_path: Path,
  evaluation_path: Path,
  report: dict[str, Any],
  current_pointer_path: Path | None = None,
) -> CandidateManifest:
  _validate_mlops_report(report)
  pointer_before = current_pointer_path.read_bytes() if current_pointer_path and current_pointer_path.exists() else None
  training = registry.register_file(training_path, name="training-data", revision=training_path.name)
  evaluation = registry.register_file(evaluation_path, name="evaluation-data", revision=evaluation_path.name)
  encoder_payload = _json_bytes(report["encoder"])
  encoder = registry.register_bytes(
    encoder_payload,
    name="encoder-receipt",
    revision=str(report["encoder"]["revision"]),
  )
  schema_payload = _json_bytes({
    "contract": "four-class-eisenhower-v1",
    "required_seeds": [7, 19, 31, 43, 59],
    "required_languages": ["en", "pl"],
  })
  schema = registry.register_bytes(schema_payload, name="evaluation-schema", revision="1.0.0")
  report_ref = registry.register_bytes(_json_bytes(report), name="mlops-report", revision=candidate_id)
  runtime_text = f"python:{platform.python_version()}"
  manifest = CandidateManifest.create(
    candidate_id=candidate_id,
    workflow="mlops",
    evidence_level="local_in_process",
    created_at=datetime.now(UTC),
    git=GitLineage(commit_sha=git_sha, dirty=git_dirty),
    datasets=LineageGroup(items=(training, evaluation)),
    models=LineageGroup(items=(encoder,)),
    prompts=LineageGroup(not_applicable_reason="classifier candidate does not execute prompts"),
    schemas=LineageGroup(items=(schema,)),
    corpora=LineageGroup(not_applicable_reason="classifier candidate has no RAG corpus"),
    qdrant_collections=LineageGroup(
      not_applicable_reason="classifier candidate does not build a Qdrant collection"
    ),
    runtimes=(RuntimeLineage(
      name="python",
      version=platform.python_version(),
      digest=sha256(runtime_text.encode()).hexdigest(),
    ),),
    reports=LineageGroup(items=(report_ref,)),
  )
  registry.register_manifest(manifest)
  pointer_after = current_pointer_path.read_bytes() if current_pointer_path and current_pointer_path.exists() else None
  if pointer_before != pointer_after:
    raise CandidateWorkflowError("candidate workflow changed the current model pointer")
  return manifest


def _validate_ragops_report(report: dict[str, Any]) -> None:
  try:
    reconciled = report["reconciliation"]
    restore = report["snapshot_restore"]
    required = (
      report["canonical_before_vector"] is True,
      report["ingestion"]["failed"] == 0,
      all(reconciled[key] == 0 for key in ("missing", "stale", "orphan")),
      restore["verified"] is True and restore["checksum_match"] is True and restore["isolated"] is True,
      report["alias_promoted"] is False,
      bool(report["evaluation"]["dataset"]),
      bool(report["collection"]["name"]),
      bool(report["runtime"]["qdrant_version"]),
      bool(report["runtime"]["mongo_version"]),
    )
  except (KeyError, TypeError) as issue:
    raise CandidateWorkflowError("RAGOps candidate evidence is incomplete") from issue
  if not all(required):
    raise CandidateWorkflowError("RAGOps candidate evidence failed integrity or recovery gates")


def register_ragops_candidate(
  *,
  registry: ImmutableArtifactRegistry,
  candidate_id: str,
  git_sha: str,
  git_dirty: bool,
  corpus_manifest_path: Path,
  golden_path: Path,
  snapshot_path: Path,
  report: dict[str, Any],
) -> CandidateManifest:
  _validate_ragops_report(report)
  corpus = registry.register_file(corpus_manifest_path, name="corpus-manifest", revision=corpus_manifest_path.name)
  golden = registry.register_file(golden_path, name="retrieval-golden", revision=golden_path.name)
  snapshot = registry.register_file(snapshot_path, name="qdrant-snapshot", revision=candidate_id)
  collection = registry.register_bytes(
    _json_bytes(report["collection"]),
    name="qdrant-collection-receipt",
    revision=str(report["collection"]["revision"]),
  )
  encoder = registry.register_bytes(
    _json_bytes({"revision": report["collection"]["revision"]}),
    name="encoder-receipt",
    revision=str(report["collection"]["revision"]),
  )
  schema = registry.register_bytes(
    _json_bytes({"contract": "canonical-mongo-before-qdrant-v1"}),
    name="canonical-schema",
    revision="1.0.0",
  )
  report_ref = registry.register_bytes(_json_bytes(report), name="ragops-report", revision=candidate_id)
  runtimes = tuple(
    RuntimeLineage(
      name=name,
      version=str(version),
      digest=sha256(f"{name}:{version}".encode()).hexdigest(),
    )
    for name, version in (
      ("qdrant", report["runtime"]["qdrant_version"]),
      ("mongodb", report["runtime"]["mongo_version"]),
    )
  )
  manifest = CandidateManifest.create(
    candidate_id=candidate_id,
    workflow="ragops",
    evidence_level="local_live_dependency",
    created_at=datetime.now(UTC),
    git=GitLineage(commit_sha=git_sha, dirty=git_dirty),
    datasets=LineageGroup(items=(golden,)),
    models=LineageGroup(items=(encoder,)),
    prompts=LineageGroup(not_applicable_reason="retrieval candidate does not execute generation prompts"),
    schemas=LineageGroup(items=(schema,)),
    corpora=LineageGroup(items=(corpus,)),
    qdrant_collections=LineageGroup(items=(collection,)),
    runtimes=runtimes,
    reports=LineageGroup(items=(report_ref, snapshot)),
  )
  registry.register_manifest(manifest)
  return manifest


def _validate_llmops_report(report: dict[str, Any]) -> str:
  try:
    evidence_level = str(report["evidence_level"])
    live = report["live_model"]
    required = (
      report["languages"]["pl"]["passed"] is True,
      report["languages"]["en"]["passed"] is True,
      report["safety"]["prompt_injection"]["passed"] is True,
      report["safety"]["citation_fabrication"]["passed"] is True,
      report["structured_output"]["passed"] is True,
      report["regression"]["passed"] is True,
      report["candidate_gate"]["passed"] is True,
    )
  except (KeyError, TypeError) as issue:
    raise CandidateWorkflowError("LLMOps candidate evidence is incomplete") from issue
  if evidence_level not in {"local_mock", "local_in_process", "ci_in_process", "live_model"}:
    raise CandidateWorkflowError("LLMOps candidate evidence level is invalid")
  if not all(required):
    raise CandidateWorkflowError("LLMOps candidate evidence failed a required gate")
  if evidence_level != "live_model" and (live["executed"] is True or live["passed"] is True):
    raise CandidateWorkflowError("LLMOps candidate evidence makes a false live-model claim")
  if evidence_level == "live_model" and not (live["executed"] is True and live["passed"] is True):
    raise CandidateWorkflowError("LLMOps candidate evidence lacks a live-model run")
  return evidence_level


def register_llmops_candidate(
  *,
  registry: ImmutableArtifactRegistry,
  candidate_id: str,
  git_sha: str,
  git_dirty: bool,
  prompt_paths: list[Path],
  schema_path: Path,
  golden_path: Path,
  report: dict[str, Any],
) -> CandidateManifest:
  evidence_level = _validate_llmops_report(report)
  specs = [PromptSpec.model_validate_json(path.read_text(encoding="utf-8")) for path in prompt_paths]
  if {spec.language for spec in specs} != {"pl", "en"} or not all(spec.verify_checksum() for spec in specs):
    raise CandidateWorkflowError("LLMOps candidate evidence requires checksum-valid PL/EN PromptSpecs")
  prompt_refs = tuple(
    registry.register_file(path, name=f"prompt-{spec.language}", revision=spec.prompt_version)
    for path, spec in zip(prompt_paths, specs, strict=True)
  )
  schema = registry.register_file(schema_path, name="output-schema", revision=specs[0].output_schema_version)
  golden = registry.register_file(golden_path, name="llm-golden", revision=golden_path.name)
  matrix = {
    "models": sorted({(spec.model_id, spec.model_revision) for spec in specs}),
    "tokenizers": sorted({(spec.tokenizer_id, spec.tokenizer_revision) for spec in specs}),
    "chat_template_hashes": sorted({spec.chat_template_hash for spec in specs}),
    "token_budgets": {
      spec.language: {
        "max_model_tokens": spec.max_model_tokens,
        "output_reserve": spec.output_reserve,
        "safety_reserve": spec.safety_reserve,
      }
      for spec in specs
    },
  }
  model = registry.register_bytes(_json_bytes(matrix), name="model-tokenizer-receipt", revision=candidate_id)
  report_ref = registry.register_bytes(_json_bytes(report), name="llmops-report", revision=candidate_id)
  runtime_text = f"python:{platform.python_version()}:{evidence_level}"
  manifest = CandidateManifest.create(
    candidate_id=candidate_id,
    workflow="llmops",
    evidence_level=evidence_level,
    created_at=datetime.now(UTC),
    git=GitLineage(commit_sha=git_sha, dirty=git_dirty),
    datasets=LineageGroup(items=(golden,)),
    models=LineageGroup(items=(model,)),
    prompts=LineageGroup(items=prompt_refs),
    schemas=LineageGroup(items=(schema,)),
    corpora=LineageGroup(not_applicable_reason="offline LLM candidate has no private corpus"),
    qdrant_collections=LineageGroup(
      not_applicable_reason="offline LLM candidate does not access Qdrant"
    ),
    runtimes=(RuntimeLineage(
      name="python-in-process-evaluator",
      version=platform.python_version(),
      digest=sha256(runtime_text.encode()).hexdigest(),
    ),),
    reports=LineageGroup(items=(report_ref,)),
  )
  registry.register_manifest(manifest)
  return manifest
