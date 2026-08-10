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
        RetrievalQuery(text=case.task, scope=scope, limit=k)
      )
      analysis = self.rag_service.analyze(case.task, scope)
      elapsed_ms = max(0.0, (self.clock() - started) * 1000)
      results.append(EvaluationCaseResult(
        case_id=case.case_id,
        relevant_document_ids=case.relevant_document_ids,
        retrieved_document_ids=[hit.document_id for hit in hits],
        allowed_citation_ids=case.allowed_citation_ids,
        actual_citation_ids=[citation.chunk_id for citation in analysis.citations],
        expected_no_answer=case.answerability == "no_answer",
        actual_no_answer=analysis.mode != "rag" and not analysis.citations,
        grounded=analysis.mode == "rag" and bool(analysis.citations),
        latency_ms=elapsed_ms,
      ))
    return {
      "dataset_version": next(iter(versions)),
      "metrics": evaluate_results(results, k=k),
      "cases": [result.model_dump() for result in results],
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
