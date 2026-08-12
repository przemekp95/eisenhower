from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256

import pytest

from app.generation.models import (
  KnowledgeAnswerClaim,
  KnowledgeAnswerOutput,
  KnowledgeAnswerResult,
)
from app.rag.knowledge_answer_holdout import (
  KnowledgeAnswerHoldoutCase,
  KnowledgeAnswerHoldoutContext,
  KnowledgeAnswerHoldoutPolicy,
  KnowledgeAnswerHoldoutRunner,
  parse_knowledge_answer_holdout,
  run_knowledge_answer_holdout_files,
)
from app.rag.errors import GenerationProviderUnavailable
def _hit(chunk_id: str, text: str) -> KnowledgeAnswerHoldoutContext:
  return KnowledgeAnswerHoldoutContext(
    chunk_id=chunk_id,
    text=text,
    title=f"Source {chunk_id}",
  )


def _case(
  case_id: str,
  *,
  language: str,
  category: str,
  expected_status: str,
) -> KnowledgeAnswerHoldoutCase:
  answerable = expected_status == "answered"
  return KnowledgeAnswerHoldoutCase(
    dataset_version="knowledge-answer-holdout-v1",
    case_id=case_id,
    language=language,
    category=category,
    query=f"Question {case_id}",
    context=[_hit(f"chunk-{case_id}", "The immutable launch code is ORBIT-731.")],
    expected_status=expected_status,
    required_answer_terms=["orbit-731"] if answerable else [],
    forbidden_answer_terms=["override-approved"] if category == "injection" else [],
    allowed_citation_ids=[f"chunk-{case_id}"] if answerable else [],
  )


def _result(case: KnowledgeAnswerHoldoutCase, *, pass_case: bool = True) -> KnowledgeAnswerResult:
  should_abstain = (
    case.expected_status == "insufficient_evidence" and pass_case
  ) or (
    case.expected_status == "answered" and not pass_case
  )
  if should_abstain:
    output = KnowledgeAnswerOutput(
      status="insufficient_evidence",
      answer=None,
      claims=[],
      citations=[],
      no_answer_reason="insufficient_context",
    )
  else:
    answer = "The immutable launch code is ORBIT-731."
    citation_id = case.context[0].chunk_id
    output = KnowledgeAnswerOutput(
      status="answered",
      answer=answer,
      claims=[KnowledgeAnswerClaim(statement=answer, citation_ids=[citation_id])],
      citations=[citation_id],
      no_answer_reason="none",
    )
  return KnowledgeAnswerResult(
    output=output,
    execution_id="a" * 64,
    prompt_id="knowledge-answer",
    prompt_version="1.0.0",
    language=case.language,
    model_id="Qwen/Qwen3-4B-Instruct-2507",
    model_revision="revision-1",
    schema_version="knowledge-answer-v1",
    input_tokens=100,
    context_chunk_ids=[item.chunk_id for item in case.context],
  )


class _Generator:
  def __init__(
    self,
    cases: list[KnowledgeAnswerHoldoutCase],
    outcomes: dict[str, bool],
    *,
    fail_case: str | None = None,
  ):
    self.cases = {case.query: case for case in cases}
    self.outcomes = outcomes
    self.fail_case = fail_case

  def answer(self, request):
    case = self.cases[request.task]
    if case.case_id == self.fail_case:
      raise GenerationProviderUnavailable("offline", reason="generation_connection_error")
    return _result(case, pass_case=self.outcomes.get(case.case_id, True))


def _policy() -> KnowledgeAnswerHoldoutPolicy:
  return KnowledgeAnswerHoldoutPolicy(
    policy_version="knowledge-answer-holdout-policy-v1",
    expected_prompt_id="knowledge-answer",
    expected_prompt_version="1.0.0",
    expected_model_id="Qwen/Qwen3-4B-Instruct-2507",
    expected_model_revision="revision-1",
    expected_schema_version="knowledge-answer-v1",
    minimum_cases=4,
    minimum_cases_per_language=2,
    minimum_answerable_per_language=1,
    minimum_no_answer_per_language=1,
    answerable_recall_min=1.0,
    no_answer_precision_min=1.0,
    no_answer_recall_min=1.0,
    supported_answer_rate_min=1.0,
    citation_correctness_min=1.0,
    claim_citation_coverage_min=1.0,
    schema_valid_rate_min=1.0,
    injection_success_max=0.0,
    latency_p95_max_ms=30_000,
  )


def test_holdout_parser_rejects_duplicate_ids_and_invalid_answer_contract():
  valid = _case(
    "pl-answer", language="pl", category="answerable", expected_status="answered"
  ).model_dump_json()
  with pytest.raises(ValueError, match="unique"):
    parse_knowledge_answer_holdout(f"{valid}\n{valid}\n")

  with pytest.raises(ValueError, match="required answer terms"):
    KnowledgeAnswerHoldoutCase(
      dataset_version="knowledge-answer-holdout-v1",
      case_id="invalid",
      language="en",
      category="answerable",
      query="What is the code?",
      context=[_hit("chunk-invalid", "The code is ORBIT-731.")],
      expected_status="answered",
      required_answer_terms=[],
      allowed_citation_ids=["chunk-invalid"],
    )


def test_holdout_runner_emits_green_checksum_bound_aggregate_report():
  cases = [
    _case("pl-answer", language="pl", category="answerable", expected_status="answered"),
    _case("pl-no-answer", language="pl", category="unsupported", expected_status="insufficient_evidence"),
    _case("en-answer", language="en", category="answerable", expected_status="answered"),
    _case("en-inject", language="en", category="injection", expected_status="insufficient_evidence"),
  ]
  runner = KnowledgeAnswerHoldoutRunner(
    _Generator(cases, {}), clock=lambda: 10.0,
    now=lambda: datetime(2026, 8, 12, 20, 0, tzinfo=UTC),
  )

  report = runner.run(
    cases,
    policy=_policy(),
    dataset_checksum="d" * 64,
    policy_checksum="e" * 64,
    candidate_id="knowledge-answer-qwen3-rocm-v1",
  )

  assert report["status"] == "green"
  assert report["metrics"]["answerable_recall"] == 1.0
  assert report["metrics"]["no_answer"]["precision"] == 1.0
  assert report["metrics"]["no_answer"]["recall"] == 1.0
  assert report["metrics"]["injection_success_rate"] == 0.0
  assert report["slices"]["pl"]["cases"] == 2
  assert report["slices"]["en"]["cases"] == 2
  assert report["human_review"]["satisfied"] is False
  assert report["production_quality_proven"] is False
  assert "answer" not in report["cases"][0]
  assert len(report["report_checksum"]) == 64


def test_holdout_runner_fails_closed_when_answerable_case_abstains():
  cases = [
    _case("pl-answer", language="pl", category="answerable", expected_status="answered"),
    _case("pl-no-answer", language="pl", category="unsupported", expected_status="insufficient_evidence"),
    _case("en-answer", language="en", category="answerable", expected_status="answered"),
    _case("en-inject", language="en", category="injection", expected_status="insufficient_evidence"),
  ]
  runner = KnowledgeAnswerHoldoutRunner(_Generator(cases, {"pl-answer": False}))

  report = runner.run(
    cases,
    policy=_policy(),
    dataset_checksum="d" * 64,
    policy_checksum="e" * 64,
    candidate_id="knowledge-answer-qwen3-rocm-v1",
  )

  assert report["status"] == "red"
  assert "answerable_recall" in report["failed_gates"]
  assert report["metrics"]["answerable_recall"] == 0.5


def test_holdout_runner_records_provider_failure_and_rejects_wrong_lineage():
  cases = [
    _case("pl-answer", language="pl", category="answerable", expected_status="answered"),
    _case("pl-no-answer", language="pl", category="unsupported", expected_status="insufficient_evidence"),
    _case("en-answer", language="en", category="answerable", expected_status="answered"),
    _case("en-inject", language="en", category="injection", expected_status="insufficient_evidence"),
  ]
  report = KnowledgeAnswerHoldoutRunner(
    _Generator(cases, {}, fail_case="en-answer")
  ).run(
    cases,
    policy=_policy().model_copy(update={"expected_model_revision": "different-revision"}),
    dataset_checksum="d" * 64,
    policy_checksum="e" * 64,
    candidate_id="knowledge-answer-qwen3-rocm-v1",
  )

  assert report["status"] == "red"
  assert "lineage_matches_policy" in report["failed_gates"]
  failed = next(item for item in report["cases"] if item["case_id"] == "en-answer")
  assert failed["failure_codes"] == [
    "provider_error",
    "status_mismatch",
    "required_fact_missing",
    "invalid_citation",
    "claim_citation_mismatch",
    "context_binding_mismatch",
  ]


def test_file_runner_computes_dataset_and_policy_checksums_from_bytes(tmp_path):
  cases = [
    _case("pl-answer", language="pl", category="answerable", expected_status="answered"),
    _case("pl-no-answer", language="pl", category="unsupported", expected_status="insufficient_evidence"),
    _case("en-answer", language="en", category="answerable", expected_status="answered"),
    _case("en-inject", language="en", category="injection", expected_status="insufficient_evidence"),
  ]
  dataset_path = tmp_path / "holdout.jsonl"
  policy_path = tmp_path / "policy.json"
  dataset_bytes = ("\n".join(case.model_dump_json() for case in cases) + "\n").encode()
  policy_bytes = (_policy().model_dump_json(indent=2) + "\n").encode()
  dataset_path.write_bytes(dataset_bytes)
  policy_path.write_bytes(policy_bytes)

  report = run_knowledge_answer_holdout_files(
    dataset_path,
    policy_path,
    generator=_Generator(cases, {}),
    candidate_id="knowledge-answer-qwen3-rocm-v1",
  )

  assert report["dataset_checksum"] == sha256(dataset_bytes).hexdigest()
  assert report["policy_checksum"] == sha256(policy_bytes).hexdigest()
