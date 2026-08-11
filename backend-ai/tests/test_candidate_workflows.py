from __future__ import annotations

from pathlib import Path

import pytest

from app.artifacts.registry import ImmutableArtifactRegistry
from app.ops.candidates import (
  CandidateWorkflowError,
  register_mlops_candidate,
  register_llmops_candidate,
  register_ragops_candidate,
)


def _mlops_report() -> dict:
  by_language = {"pl": {"macro_f1": 0.8}, "en": {"macro_f1": 0.81}}
  return {
    "scope": "local",
    "encoder": {"name": "minilm", "revision": "encoder-revision"},
    "held_out_evaluation": {
      "mlp": {"macro_f1": 0.8, "by_language": by_language},
      "centroid": {"macro_f1": 0.7},
      "incumbent": {"available": True, "generation_id": "incumbent-v1"},
      "multi_seed": [
        {"seed": seed, "metrics": {"macro_f1": 0.8, "by_language": by_language}}
        for seed in (7, 19, 31, 43, 59)
      ],
      "macro_f1_stability": {"minimum": 0.79, "standard_deviation": 0.01},
    },
    "development_promotion_gate": {"passed": True, "reasons": []},
    "semantic_leakage": {"pairs_above_threshold": 0},
    "production_readiness": {
      "passed": False,
      "reasons": [{"code": "dual_human_annotation_required"}],
    },
  }


def test_mlops_candidate_registers_complete_lineage_without_changing_current_pointer(tmp_path):
  training = tmp_path / "training.json"
  evaluation = tmp_path / "evaluation.json"
  current = tmp_path / "current.json"
  training.write_text("[]\n", encoding="utf-8")
  evaluation.write_text("[]\n", encoding="utf-8")
  current.write_text('{"generation_id":"incumbent-v1"}\n', encoding="utf-8")
  before = current.read_bytes()

  manifest = register_mlops_candidate(
    registry=ImmutableArtifactRegistry(tmp_path / "registry"),
    candidate_id="mlops-test-v1",
    git_sha="a" * 40,
    git_dirty=True,
    training_path=training,
    evaluation_path=evaluation,
    report=_mlops_report(),
    current_pointer_path=current,
  )

  assert manifest.workflow == "mlops"
  assert manifest.status == "candidate"
  assert manifest.evidence_level == "local_in_process"
  assert current.read_bytes() == before
  assert {item.name for item in manifest.datasets.items} == {"training-data", "evaluation-data"}
  assert {item.name for item in manifest.models.items} == {"encoder-receipt"}
  assert manifest.prompts.not_applicable_reason


@pytest.mark.parametrize("mutation", ["seed", "language", "leakage", "baseline", "incumbent"])
def test_mlops_candidate_fails_closed_when_required_evidence_is_missing(tmp_path, mutation):
  report = _mlops_report()
  if mutation == "seed":
    report["held_out_evaluation"]["multi_seed"].pop()
  elif mutation == "language":
    del report["held_out_evaluation"]["mlp"]["by_language"]["en"]
  elif mutation == "leakage":
    del report["semantic_leakage"]
  elif mutation == "baseline":
    del report["held_out_evaluation"]["centroid"]
  else:
    del report["held_out_evaluation"]["incumbent"]
  training = tmp_path / "training.json"
  evaluation = tmp_path / "evaluation.json"
  training.write_text("[]", encoding="utf-8")
  evaluation.write_text("[]", encoding="utf-8")

  with pytest.raises(CandidateWorkflowError, match="MLOps candidate evidence"):
    register_mlops_candidate(
      registry=ImmutableArtifactRegistry(tmp_path / "registry"),
      candidate_id="mlops-invalid-v1",
      git_sha="a" * 40,
      git_dirty=False,
      training_path=training,
      evaluation_path=evaluation,
      report=report,
    )


def _ragops_report() -> dict:
  return {
    "canonical_before_vector": True,
    "ingestion": {"documents": 19, "failed": 0},
    "reconciliation": {"missing": 0, "stale": 0, "orphan": 0},
    "evaluation": {"dataset": "retrieval-v1", "recall_at_k": 0.66, "mrr_at_k": 0.54},
    "snapshot_restore": {"verified": True, "checksum_match": True, "isolated": True},
    "collection": {"name": "eisenhower_candidate_v1", "revision": "minilm-v1"},
    "runtime": {"qdrant_version": "1.12.0", "mongo_version": "7.0"},
    "alias_promoted": False,
    "representative_human_gate": {"passed": False, "reason": "TASK-013 pending"},
  }


def test_ragops_candidate_registers_recovery_lineage_without_alias_promotion(tmp_path):
  corpus = tmp_path / "corpus.json"
  golden = tmp_path / "golden.jsonl"
  snapshot = tmp_path / "snapshot.bin"
  corpus.write_text('{"manifest_version":"v1"}\n', encoding="utf-8")
  golden.write_text('{"query":"test"}\n', encoding="utf-8")
  snapshot.write_bytes(b"qdrant-snapshot")

  manifest = register_ragops_candidate(
    registry=ImmutableArtifactRegistry(tmp_path / "registry"),
    candidate_id="ragops-test-v1",
    git_sha="b" * 40,
    git_dirty=False,
    corpus_manifest_path=corpus,
    golden_path=golden,
    snapshot_path=snapshot,
    report=_ragops_report(),
  )

  assert manifest.workflow == "ragops"
  assert manifest.evidence_level == "local_live_dependency"
  assert {item.name for item in manifest.corpora.items} == {"corpus-manifest"}
  assert {item.name for item in manifest.qdrant_collections.items} == {"qdrant-collection-receipt"}
  assert {item.name for item in manifest.reports.items} == {"ragops-report", "qdrant-snapshot"}


@pytest.mark.parametrize("field", ["ordering", "reconciliation", "restore", "alias"])
def test_ragops_candidate_fails_closed_on_integrity_or_promotion_violation(tmp_path, field):
  report = _ragops_report()
  if field == "ordering":
    report["canonical_before_vector"] = False
  elif field == "reconciliation":
    report["reconciliation"]["orphan"] = 1
  elif field == "restore":
    report["snapshot_restore"]["checksum_match"] = False
  else:
    report["alias_promoted"] = True
  corpus = tmp_path / "corpus.json"
  golden = tmp_path / "golden.jsonl"
  snapshot = tmp_path / "snapshot.bin"
  corpus.write_text("{}", encoding="utf-8")
  golden.write_text("{}", encoding="utf-8")
  snapshot.write_bytes(b"snapshot")

  with pytest.raises(CandidateWorkflowError, match="RAGOps candidate evidence"):
    register_ragops_candidate(
      registry=ImmutableArtifactRegistry(tmp_path / "registry"),
      candidate_id="ragops-invalid-v1",
      git_sha="b" * 40,
      git_dirty=False,
      corpus_manifest_path=corpus,
      golden_path=golden,
      snapshot_path=snapshot,
      report=report,
    )


def _llmops_report() -> dict:
  return {
    "evidence_level": "local_in_process",
    "languages": {"pl": {"passed": True}, "en": {"passed": True}},
    "safety": {"prompt_injection": {"passed": True}, "citation_fabrication": {"passed": True}},
    "structured_output": {"passed": True, "schema_rejections": 0},
    "regression": {"passed": True, "champion_checksum": "c" * 64},
    "live_model": {"executed": False, "passed": False},
    "candidate_gate": {"passed": True, "reasons": []},
  }


def test_llmops_candidate_registers_prompt_schema_and_golden_with_honest_evidence(tmp_path):
  repository = Path(__file__).resolve().parents[2]
  prompts = [
    repository / "backend-ai" / "prompts" / "eisenhower-classifier" / "1.0.0" / name
    for name in ("pl.json", "en.json")
  ]
  schema = tmp_path / "schema.json"
  schema.write_text('{"type":"object"}\n', encoding="utf-8")

  manifest = register_llmops_candidate(
    registry=ImmutableArtifactRegistry(tmp_path / "registry"),
    candidate_id="llmops-test-v1",
    git_sha="c" * 40,
    git_dirty=False,
    prompt_paths=prompts,
    schema_path=schema,
    golden_path=repository / "backend-ai" / "evaluation" / "golden-v1.jsonl",
    report=_llmops_report(),
  )

  assert manifest.workflow == "llmops"
  assert manifest.evidence_level == "local_in_process"
  assert {item.name for item in manifest.prompts.items} == {"prompt-pl", "prompt-en"}
  assert {item.name for item in manifest.schemas.items} == {"output-schema"}
  assert manifest.qdrant_collections.not_applicable_reason


@pytest.mark.parametrize("field", ["language", "safety", "schema", "regression", "live_claim"])
def test_llmops_candidate_fails_closed_on_missing_gate_or_fake_live_claim(tmp_path, field):
  repository = Path(__file__).resolve().parents[2]
  prompts = [
    repository / "backend-ai" / "prompts" / "eisenhower-classifier" / "1.0.0" / name
    for name in ("pl.json", "en.json")
  ]
  schema = tmp_path / "schema.json"
  schema.write_text("{}", encoding="utf-8")
  report = _llmops_report()
  if field == "language":
    del report["languages"]["en"]
  elif field == "safety":
    report["safety"]["prompt_injection"]["passed"] = False
  elif field == "schema":
    report["structured_output"]["passed"] = False
  elif field == "regression":
    report["regression"]["passed"] = False
  else:
    report["live_model"] = {"executed": False, "passed": True}

  with pytest.raises(CandidateWorkflowError, match="LLMOps candidate evidence"):
    register_llmops_candidate(
      registry=ImmutableArtifactRegistry(tmp_path / "registry"),
      candidate_id="llmops-invalid-v1",
      git_sha="c" * 40,
      git_dirty=False,
      prompt_paths=prompts,
      schema_path=schema,
      golden_path=repository / "backend-ai" / "evaluation" / "golden-v1.jsonl",
      report=report,
    )
