from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256
import json
from math import ceil
from pathlib import Path
from time import perf_counter
from typing import Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .errors import GenerationProviderError
from .models import KnowledgeAnswerRequest, RetrievalHit


class KnowledgeAnswerHoldoutContext(BaseModel):
  model_config = ConfigDict(extra="forbid")

  chunk_id: str = Field(..., min_length=1)
  title: str = Field(..., min_length=1)
  text: str = Field(..., min_length=1, max_length=1200)

  def as_retrieval_hit(self) -> RetrievalHit:
    return RetrievalHit(
      chunk_id=self.chunk_id,
      document_id=f"holdout-{self.chunk_id}",
      text=self.text,
      score=1.0,
      source_uri=f"holdout://{self.chunk_id}",
      title=self.title,
      tenant_id="knowledge-answer-holdout",
      project_id="knowledge-answer-holdout",
      embedding_version="holdout-fixed-context-v1",
      content_version="knowledge-answer-holdout-v1",
    )


class KnowledgeAnswerHoldoutCase(BaseModel):
  model_config = ConfigDict(extra="forbid")

  dataset_version: str = Field(..., min_length=1)
  case_id: str = Field(..., min_length=1)
  language: Literal["pl", "en"]
  category: Literal["answerable", "unsupported", "injection"]
  query: str = Field(..., min_length=1, max_length=2000)
  context: list[KnowledgeAnswerHoldoutContext] = Field(..., min_length=1, max_length=5)
  expected_status: Literal["answered", "insufficient_evidence"]
  required_answer_terms: list[str] = Field(default_factory=list, max_length=12)
  forbidden_answer_terms: list[str] = Field(default_factory=list, max_length=12)
  allowed_citation_ids: list[str] = Field(default_factory=list, max_length=5)

  @model_validator(mode="after")
  def validate_expected_contract(self):
    context_ids = {item.chunk_id for item in self.context}
    if len(context_ids) != len(self.context):
      raise ValueError("context chunk ids must be unique")
    if not set(self.allowed_citation_ids).issubset(context_ids):
      raise ValueError("allowed citation ids must belong to the context")
    if self.category == "answerable":
      if self.expected_status != "answered":
        raise ValueError("answerable cases must expect an answer")
      if not self.required_answer_terms:
        raise ValueError("answerable cases require required answer terms")
      if not self.allowed_citation_ids:
        raise ValueError("answerable cases require allowed citations")
    elif self.expected_status != "insufficient_evidence":
      raise ValueError("unsupported and injection cases must expect insufficient evidence")
    if any(not term.strip() for term in self.required_answer_terms + self.forbidden_answer_terms):
      raise ValueError("answer terms must not be blank")
    return self


class KnowledgeAnswerHoldoutPolicy(BaseModel):
  model_config = ConfigDict(extra="forbid")

  policy_version: str = Field(..., min_length=1)
  expected_prompt_id: str = Field(..., min_length=1)
  expected_prompt_version: str = Field(..., min_length=1)
  expected_model_id: str = Field(..., min_length=1)
  expected_model_revision: str = Field(..., min_length=1)
  expected_schema_version: str = Field(..., min_length=1)
  minimum_cases: int = Field(..., ge=1)
  minimum_cases_per_language: int = Field(..., ge=1)
  minimum_answerable_per_language: int = Field(..., ge=1)
  minimum_no_answer_per_language: int = Field(..., ge=1)
  minimum_injection_per_language: int = Field(default=0, ge=0)
  answerable_recall_min: float = Field(..., ge=0.0, le=1.0)
  no_answer_precision_min: float = Field(..., ge=0.0, le=1.0)
  no_answer_recall_min: float = Field(..., ge=0.0, le=1.0)
  supported_answer_rate_min: float = Field(..., ge=0.0, le=1.0)
  citation_correctness_min: float = Field(..., ge=0.0, le=1.0)
  claim_citation_coverage_min: float = Field(..., ge=0.0, le=1.0)
  schema_valid_rate_min: float = Field(..., ge=0.0, le=1.0)
  injection_success_max: float = Field(..., ge=0.0, le=1.0)
  latency_p95_max_ms: float = Field(..., gt=0.0)


def parse_knowledge_answer_holdout(content: str) -> list[KnowledgeAnswerHoldoutCase]:
  cases = [
    KnowledgeAnswerHoldoutCase.model_validate_json(line)
    for line in content.splitlines()
    if line.strip()
  ]
  if not cases:
    raise ValueError("knowledge-answer holdout must not be empty")
  if len({case.case_id for case in cases}) != len(cases):
    raise ValueError("knowledge-answer holdout case ids must be unique")
  if len({case.dataset_version for case in cases}) != 1:
    raise ValueError("knowledge-answer holdout must use one dataset version")
  return cases


def _ratio(numerator: int, denominator: int) -> float:
  return round(numerator / denominator, 4) if denominator else 0.0


def _p95(values: list[float]) -> float:
  if not values:
    return 0.0
  ordered = sorted(values)
  return round(ordered[max(0, ceil(0.95 * len(ordered)) - 1)], 2)


def _checksum(payload: dict) -> str:
  encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
  return sha256(encoded).hexdigest()


class KnowledgeAnswerHoldoutRunner:
  """Scores a sealed fixed-context response packet without model-as-judge labels."""

  def __init__(
    self,
    generator,
    *,
    clock: Callable[[], float] = perf_counter,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
  ):
    self.generator = generator
    self.clock = clock
    self.now = now

  def run(
    self,
    cases: list[KnowledgeAnswerHoldoutCase],
    *,
    policy: KnowledgeAnswerHoldoutPolicy,
    dataset_checksum: str,
    policy_checksum: str,
    candidate_id: str,
    evidence_level: str = "in_process_holdout",
  ) -> dict:
    if not cases:
      raise ValueError("knowledge-answer holdout cases are required")
    if len({case.dataset_version for case in cases}) != 1:
      raise ValueError("knowledge-answer holdout requires one dataset version")
    if any(len(value) != 64 for value in (dataset_checksum, policy_checksum)):
      raise ValueError("dataset and policy checksums must be SHA-256 values")
    case_results = [self._run_case(case) for case in cases]
    metrics = self._metrics(case_results)
    slices = {
      language: self._metrics([
        result for result in case_results if result["language"] == language
      ])
      for language in ("pl", "en")
    }
    failed_gates = self._failed_gates(cases, metrics, slices, policy)
    lineages = {
      tuple(result["lineage"].values())
      for result in case_results
      if result["lineage"] is not None
    }
    lineage_consistent = len(lineages) == 1 and all(
      result["lineage"] is not None for result in case_results
    )
    if not lineage_consistent:
      failed_gates.append("lineage_consistent")
    expected_lineage = {
      "prompt_id": policy.expected_prompt_id,
      "prompt_version": policy.expected_prompt_version,
      "model_id": policy.expected_model_id,
      "model_revision": policy.expected_model_revision,
      "schema_version": policy.expected_schema_version,
    }
    if not lineage_consistent or case_results[0]["lineage"] != expected_lineage:
      failed_gates.append("lineage_matches_policy")
    status = "green" if not failed_gates else "red"
    report = {
      "schema_version": "knowledge-answer-holdout-report-v1",
      "dataset_version": cases[0].dataset_version,
      "dataset_checksum": dataset_checksum,
      "policy_version": policy.policy_version,
      "policy_checksum": policy_checksum,
      "current_candidate_id": candidate_id,
      "generated_at": self.now().astimezone(UTC).isoformat(),
      "evidence_level": evidence_level,
      "status": status,
      "failed_gates": sorted(set(failed_gates)),
      "metrics": metrics,
      "slices": slices,
      "lineage": case_results[0]["lineage"] if lineage_consistent else None,
      "cases": [
        {
          "case_id": result["case_id"],
          "language": result["language"],
          "category": result["category"],
          "expected_status": result["expected_status"],
          "actual_status": result["actual_status"],
          "passed": result["passed"],
          "failure_codes": result["failure_codes"],
          "latency_ms": result["latency_ms"],
        }
        for result in case_results
      ],
      "human_review": {
        "required_for_production": True,
        "satisfied": False,
        "reason": "technical holdout is not an independent human review",
      },
      "production_quality_proven": False,
    }
    report["report_checksum"] = _checksum(report)
    return report

  def _run_case(self, case: KnowledgeAnswerHoldoutCase) -> dict:
    started = self.clock()
    provider_error = False
    try:
      generated = self.generator.answer(KnowledgeAnswerRequest(
        task=case.query,
        context=[item.as_retrieval_hit() for item in case.context],
        language=case.language,
        retrieval_version="holdout-retrieval-v1",
        index_version="holdout-index-v1",
      ))
      output = generated.output
      lineage = {
        "prompt_id": generated.prompt_id,
        "prompt_version": generated.prompt_version,
        "model_id": generated.model_id,
        "model_revision": generated.model_revision,
        "schema_version": generated.schema_version,
      }
      context_bound = set(generated.context_chunk_ids) == {
        item.chunk_id for item in case.context
      }
    except GenerationProviderError:
      output = None
      lineage = None
      context_bound = False
      provider_error = True
    latency_ms = round(max(0.0, (self.clock() - started) * 1000), 2)
    actual_status = output.status if output is not None else "provider_error"
    answer = (output.answer or "").casefold() if output is not None else ""
    schema_valid = output is not None
    status_correct = actual_status == case.expected_status
    fact_supported = (
      output is not None
      and output.status == "answered"
      and all(term.casefold() in answer for term in case.required_answer_terms)
    ) if case.category == "answerable" else True
    citations = set(output.citations) if output is not None else set()
    if case.expected_status == "answered":
      citation_correct = bool(citations) and citations.issubset(case.allowed_citation_ids)
    else:
      citation_correct = not citations
    claim_citations = {
      citation_id
      for claim in (output.claims if output is not None else [])
      for citation_id in claim.citation_ids
    }
    claim_coverage = (
      output is not None
      and (
        output.status == "insufficient_evidence"
        and not output.claims
        or output.status == "answered"
        and bool(output.claims)
        and claim_citations == citations
      )
    )
    injection_success = case.category == "injection" and (
      actual_status == "answered"
      or any(term.casefold() in answer for term in case.forbidden_answer_terms)
    )
    failure_codes = []
    for failed, code in (
      (provider_error, "provider_error"),
      (not status_correct, "status_mismatch"),
      (not fact_supported, "required_fact_missing"),
      (not citation_correct, "invalid_citation"),
      (not claim_coverage, "claim_citation_mismatch"),
      (not context_bound, "context_binding_mismatch"),
      (injection_success, "injection_success"),
    ):
      if failed:
        failure_codes.append(code)
    return {
      "case_id": case.case_id,
      "language": case.language,
      "category": case.category,
      "expected_status": case.expected_status,
      "actual_status": actual_status,
      "status_correct": status_correct,
      "fact_supported": fact_supported,
      "citation_correct": citation_correct,
      "claim_coverage": claim_coverage,
      "schema_valid": schema_valid,
      "context_bound": context_bound,
      "injection_success": injection_success,
      "latency_ms": latency_ms,
      "lineage": lineage,
      "passed": not failure_codes,
      "failure_codes": failure_codes,
    }

  @staticmethod
  def _metrics(results: list[dict]) -> dict:
    expected_answer = [result for result in results if result["expected_status"] == "answered"]
    expected_no_answer = [
      result for result in results if result["expected_status"] == "insufficient_evidence"
    ]
    actual_no_answer = [
      result for result in results if result["actual_status"] == "insufficient_evidence"
    ]
    no_answer_tp = sum(result in expected_no_answer for result in actual_no_answer)
    no_answer_fp = sum(result in expected_answer for result in actual_no_answer)
    no_answer_fn = sum(
      result["actual_status"] != "insufficient_evidence" for result in expected_no_answer
    )
    injection = [result for result in results if result["category"] == "injection"]
    return {
      "cases": len(results),
      "passed": sum(result["passed"] for result in results),
      "answerable_cases": len(expected_answer),
      "no_answer_cases": len(expected_no_answer),
      "injection_cases": len(injection),
      "status_accuracy": _ratio(sum(result["status_correct"] for result in results), len(results)),
      "answerable_recall": _ratio(
        sum(result["actual_status"] == "answered" for result in expected_answer),
        len(expected_answer),
      ),
      "supported_answer_rate": _ratio(
        sum(result["fact_supported"] and result["status_correct"] for result in expected_answer),
        len(expected_answer),
      ),
      "no_answer": {
        "precision": _ratio(no_answer_tp, no_answer_tp + no_answer_fp),
        "recall": _ratio(no_answer_tp, no_answer_tp + no_answer_fn),
      },
      "citation_correctness": _ratio(
        sum(result["citation_correct"] for result in results), len(results)
      ),
      "claim_citation_coverage": _ratio(
        sum(result["claim_coverage"] for result in results), len(results)
      ),
      "schema_valid_rate": _ratio(
        sum(result["schema_valid"] for result in results), len(results)
      ),
      "context_binding_rate": _ratio(
        sum(result["context_bound"] for result in results), len(results)
      ),
      "injection_success_rate": _ratio(
        sum(result["injection_success"] for result in injection), len(injection)
      ),
      "latency_ms": {
        "p95": _p95([result["latency_ms"] for result in results]),
        "max": round(max((result["latency_ms"] for result in results), default=0.0), 2),
      },
    }

  @staticmethod
  def _failed_gates(cases, metrics, slices, policy) -> list[str]:
    failed = []
    if len(cases) < policy.minimum_cases:
      failed.append("minimum_cases")
    for language, language_metrics in slices.items():
      if language_metrics["cases"] < policy.minimum_cases_per_language:
        failed.append(f"minimum_cases_{language}")
      if language_metrics["answerable_cases"] < policy.minimum_answerable_per_language:
        failed.append(f"minimum_answerable_{language}")
      if language_metrics["no_answer_cases"] < policy.minimum_no_answer_per_language:
        failed.append(f"minimum_no_answer_{language}")
      if language_metrics["injection_cases"] < policy.minimum_injection_per_language:
        failed.append(f"minimum_injection_{language}")
    checks = {
      "answerable_recall": metrics["answerable_recall"] >= policy.answerable_recall_min,
      "no_answer_precision": metrics["no_answer"]["precision"] >= policy.no_answer_precision_min,
      "no_answer_recall": metrics["no_answer"]["recall"] >= policy.no_answer_recall_min,
      "supported_answer_rate": metrics["supported_answer_rate"] >= policy.supported_answer_rate_min,
      "citation_correctness": metrics["citation_correctness"] >= policy.citation_correctness_min,
      "claim_citation_coverage": (
        metrics["claim_citation_coverage"] >= policy.claim_citation_coverage_min
      ),
      "schema_valid_rate": metrics["schema_valid_rate"] >= policy.schema_valid_rate_min,
      "context_binding_rate": metrics["context_binding_rate"] == 1.0,
      "injection_success_rate": (
        metrics["injection_success_rate"] <= policy.injection_success_max
      ),
      "latency_p95": metrics["latency_ms"]["p95"] <= policy.latency_p95_max_ms,
    }
    failed.extend(name for name, passed in checks.items() if not passed)
    return failed


def run_knowledge_answer_holdout_files(
  dataset_path: str | Path,
  policy_path: str | Path,
  *,
  generator,
  candidate_id: str,
  evidence_level: str = "in_process_holdout",
  git_sha: str | None = None,
) -> dict:
  dataset_bytes = Path(dataset_path).read_bytes()
  policy_bytes = Path(policy_path).read_bytes()
  cases = parse_knowledge_answer_holdout(dataset_bytes.decode("utf-8"))
  policy = KnowledgeAnswerHoldoutPolicy.model_validate_json(policy_bytes)
  report = KnowledgeAnswerHoldoutRunner(generator).run(
    cases,
    policy=policy,
    dataset_checksum=sha256(dataset_bytes).hexdigest(),
    policy_checksum=sha256(policy_bytes).hexdigest(),
    candidate_id=candidate_id,
    evidence_level=evidence_level,
  )
  if git_sha is not None:
    payload = {key: value for key, value in report.items() if key != "report_checksum"}
    payload["git_sha"] = git_sha
    payload["report_checksum"] = _checksum(payload)
    return payload
  return report
