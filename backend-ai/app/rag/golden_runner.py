from __future__ import annotations

import json
from pathlib import Path
from tempfile import NamedTemporaryFile
from time import perf_counter
from typing import Callable

from .evaluation import EvaluationCaseResult, evaluate_results
from ..job_worker import PermanentJobError
from .golden import GoldenCase, load_golden_dataset
from .models import AccessScope, RetrievalQuery
from .ports import Retriever


def select_train_strategy(reports: dict[str, dict]) -> str:
  """Select a safe candidate using train metrics without consulting dev or holdout."""
  ranked: list[tuple[tuple[float, ...], str]] = []
  for name, report in reports.items():
    metrics = report["metrics"]
    if any(metrics[key] != 0.0 for key in (
      "forbidden_hit_rate", "stale_hit_rate", "isolation_violation_rate",
    )):
      continue
    languages = metrics["by_language"]
    score = (
      min(languages["pl"]["recall_at_k"], languages["en"]["recall_at_k"]),
      min(languages["pl"]["mrr"], languages["en"]["mrr"]),
      metrics["recall_at_k"],
      metrics["mrr"],
      -metrics["document_duplicate_rate"],
    )
    ranked.append((score, name))
  if not ranked:
    raise ValueError("train selection has no candidate passing zero-tolerance gates")
  return max(ranked, key=lambda item: (item[0], item[1]))[1]


class GoldenEvaluationRunner:
  def __init__(self, rag_service, *, clock: Callable[[], float] = perf_counter):
    self.rag_service = rag_service
    self.clock = clock

  def run(self, cases: list[GoldenCase], *, k: int = 6) -> dict:
    if not cases:
      raise ValueError("Golden cases are required")
    versions = {case.dataset_version for case in cases}
    if len(versions) != 1:
      raise ValueError("Golden evaluation requires one dataset version")
    results: list[EvaluationCaseResult] = []
    for case in cases:
      scope = AccessScope(
        tenant_id=case.tenant_id,
        user_id=case.user_id,
        project_ids=case.project_ids,
        roles=case.roles,
      )
      started = self.clock()
      hits = self.rag_service.retriever.retrieve(
        RetrievalQuery(
          text=case.task,
          scope=scope,
          project_id=case.query_project_id,
          limit=k,
        )
      )
      analysis = self.rag_service.analyze(case.task, scope, language=case.language)
      elapsed_ms = max(0.0, (self.clock() - started) * 1000)
      actual_citation_ids = [citation.chunk_id for citation in analysis.citations]
      injection_attempt = "prompt-injection" in case.tags
      injection_success = injection_attempt and (
        analysis.quadrant != case.expected_quadrant
        or any(chunk_id in case.forbidden_citation_ids for chunk_id in actual_citation_ids)
      )
      generation = analysis.generation
      duplicate_hit_ids: list[str] = []
      seen_hit_ids: set[str] = set()
      for hit in hits:
        if hit.chunk_id in seen_hit_ids:
          duplicate_hit_ids.append(hit.chunk_id)
        else:
          seen_hit_ids.add(hit.chunk_id)
      results.append(EvaluationCaseResult(
        case_id=case.case_id,
        relevant_document_ids=case.relevant_document_ids,
        retrieved_document_ids=[hit.document_id for hit in hits],
        retrieved_chunk_ids=[hit.chunk_id for hit in hits],
        retrieved_content_versions=[hit.content_version for hit in hits],
        forbidden_document_ids=case.forbidden_document_ids,
        stale_document_ids=case.stale_document_ids,
        expected_content_versions=case.expected_content_versions,
        duplicate_hit_ids=duplicate_hit_ids,
        allowed_citation_ids=case.allowed_citation_ids,
        actual_citation_ids=actual_citation_ids,
        expected_no_answer=case.answerability == "no_answer",
        actual_no_answer=analysis.mode == "no_answer",
        grounded=analysis.mode == "rag" and bool(analysis.citations),
        latency_ms=elapsed_ms,
        language=case.language,
        split=case.split,
        expected_quadrant=case.expected_quadrant,
        actual_quadrant=analysis.quadrant,
        raw_confidence=analysis.confidence,
        schema_valid=True,
        injection_attempt=injection_attempt,
        injection_success=injection_success,
        result_mode=analysis.mode,
        prompt_tokens=generation.input_tokens if generation else 0,
        execution_id=generation.execution_id if generation else None,
        prompt_id=generation.prompt_id if generation else None,
        prompt_version=generation.prompt_version if generation else None,
        model_id=generation.model_id if generation else None,
        model_revision=generation.model_revision if generation else None,
        schema_version=generation.schema_version if generation else None,
      ))
    return {
      "dataset_version": next(iter(versions)),
      "metrics": evaluate_results(results, k=k),
      "cases": [result.model_dump() for result in results],
    }


class RetrievalGoldenRunner:
  """Runs retrieval gates without requiring or invoking generation."""

  def __init__(self, retriever, *, clock: Callable[[], float] = perf_counter):
    self.retriever = retriever
    self.clock = clock

  def run(self, cases: list[GoldenCase], *, k: int = 5) -> dict:
    if not cases:
      raise ValueError("Golden cases are required")
    versions = {case.dataset_version for case in cases}
    if len(versions) != 1:
      raise ValueError("Golden evaluation requires one dataset version")
    results = [self._run_case(case, k=k) for case in cases]
    return {
      "dataset_version": next(iter(versions)),
      "mode": "retrieval_only",
      "metrics": evaluate_results(results, k=k),
      "cases": [result.model_dump() for result in results],
    }

  def _run_case(self, case: GoldenCase, *, k: int) -> EvaluationCaseResult:
    scope = AccessScope(
      tenant_id=case.tenant_id,
      user_id=case.user_id,
      project_ids=case.project_ids,
      roles=case.roles,
    )
    started = self.clock()
    hits = self.retriever.retrieve(
      RetrievalQuery(
        text=case.task,
        scope=scope,
        project_id=case.query_project_id,
        limit=k,
      )
    )
    elapsed_ms = max(0.0, (self.clock() - started) * 1000)
    chunk_ids = [hit.chunk_id for hit in hits]
    duplicate_ids = [
      chunk_id for position, chunk_id in enumerate(chunk_ids)
      if chunk_id in chunk_ids[:position]
    ]
    no_hit = not hits
    return EvaluationCaseResult(
      case_id=case.case_id,
      relevant_document_ids=case.relevant_document_ids,
      retrieved_document_ids=[hit.document_id for hit in hits],
      retrieved_chunk_ids=chunk_ids,
      retrieved_content_versions=[hit.content_version for hit in hits],
      forbidden_document_ids=case.forbidden_document_ids,
      stale_document_ids=case.stale_document_ids,
      expected_content_versions=case.expected_content_versions,
      duplicate_hit_ids=duplicate_ids,
      allowed_citation_ids=[],
      actual_citation_ids=[],
      expected_no_answer=case.answerability == "no_answer",
      actual_no_answer=no_hit,
      grounded=False,
      latency_ms=elapsed_ms,
      language=case.language,
      split=case.split,
      result_mode="no_answer" if no_hit else "rag",
    )


class RetrievalStrategyComparisonRunner:
  """Compares retrieval strategies without tuning on the holdout by default."""

  _STRATEGY_ORDER = ("dense", "hybrid", "reranked")
  _SPLITS = {"train", "dev", "holdout"}

  def __init__(self, strategies: dict[str, Retriever], *, clock: Callable[[], float] = perf_counter):
    names = set(strategies)
    if not {"dense", "hybrid"}.issubset(names):
      raise ValueError("strategy comparison requires dense and hybrid retrievers")
    if not names.issubset(self._STRATEGY_ORDER):
      raise ValueError("strategy comparison accepts only dense, hybrid, and reranked")
    self.strategies = {
      name: strategies[name]
      for name in self._STRATEGY_ORDER
      if name in strategies
    }
    self.clock = clock

  def run(
    self,
    cases: list[GoldenCase],
    *,
    k: int = 5,
    split: str | None = None,
  ) -> dict:
    if split is not None and split not in self._SPLITS:
      raise ValueError("comparison split must be train, dev, or holdout")
    selected = (
      [case for case in cases if case.split == split]
      if split is not None
      else [case for case in cases if case.split != "holdout"]
    )
    if not selected:
      raise ValueError("strategy comparison has no cases in the selected split")
    if {case.language for case in selected} != {"pl", "en"}:
      raise ValueError("strategy comparison requires Polish and English cases")
    versions = {case.dataset_version for case in selected}
    if len(versions) != 1:
      raise ValueError("strategy comparison requires one dataset version")
    reports = {
      name: RetrievalGoldenRunner(retriever, clock=self.clock).run(selected, k=k)
      for name, retriever in self.strategies.items()
    }
    return {
      "schema_version": "retrieval-strategy-comparison-v1",
      "dataset_version": next(iter(versions)),
      "evaluated_split": split or "non_holdout",
      "case_ids": [case.case_id for case in selected],
      "strategies": reports,
    }


class RepositoryEvaluationHandler:
  def __init__(self, *, service_factory, datasets: dict[str, Path], output_dir: Path):
    self.service_factory = service_factory
    self.datasets = dict(datasets)
    self.output_dir = output_dir

  def __call__(self, payload: dict) -> None:
    version = str(payload.get("dataset_version") or "")
    dataset = self.datasets.get(version)
    if dataset is None:
      raise PermanentJobError("dataset version is not allowlisted")
    cases = load_golden_dataset(dataset)
    report = GoldenEvaluationRunner(self.service_factory()).run(cases)
    self.output_dir.mkdir(parents=True, exist_ok=True)
    destination = self.output_dir / f"{version}.json"
    with NamedTemporaryFile(
      mode="w", encoding="utf-8", dir=self.output_dir, prefix=f".{version}-", delete=False
    ) as temporary:
      json.dump(report, temporary, ensure_ascii=False, sort_keys=True, indent=2)
      temporary.write("\n")
      temporary_path = Path(temporary.name)
    temporary_path.replace(destination)
