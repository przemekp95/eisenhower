from __future__ import annotations

from dataclasses import dataclass
from copy import deepcopy
from hashlib import sha256
import json
from math import ceil
from pathlib import Path
import random
import unicodedata

from .golden import GoldenCase
from .hybrid import HybridRetriever
from .models import SourceDocument


_CATEGORY_COUNTS = {
  "exact-id": 8,
  "paraphrase": 8,
  "lexical-confusable": 8,
  "multi-document": 8,
  "no-answer-domain": 4,
  "no-answer-project": 4,
  "no-answer-tenant": 4,
  "no-answer-stale": 4,
}

_CONCEPTS = {
  "pl": (
    ("rotacja klucza", "wymienić klucz dostępu"),
    ("odtworzenie kopii", "przywrócić dane z backupu"),
    ("zamknięcie incydentu", "zakończyć obsługę awarii"),
    ("archiwizacja raportu", "przenieść raport do archiwum"),
    ("weryfikacja podpisu", "sprawdzić poprawność sygnatury"),
    ("odnowienie certyfikatu", "przedłużyć certyfikat usługi"),
    ("przełączenie regionu", "przenieść ruch do drugiej lokalizacji"),
    ("wznowienie kolejki", "uruchomić ponownie przetwarzanie zadań"),
  ),
  "en": (
    ("access key rotation", "replace the service access key"),
    ("backup restoration", "recover data from the backup"),
    ("incident closure", "finish handling the outage"),
    ("report archival", "move the report into the archive"),
    ("signature verification", "check whether the signature is valid"),
    ("certificate renewal", "extend the service certificate"),
    ("regional failover", "move traffic to the secondary location"),
    ("queue resumption", "start processing queued jobs again"),
  ),
}


@dataclass(frozen=True)
class Task049Dataset:
  cases: tuple[GoldenCase, ...]
  documents: tuple[SourceDocument, ...]


class QueryThresholdRetriever:
  def __init__(self, delegate, score_threshold: float):
    if not 0 <= score_threshold <= 1:
      raise ValueError("score_threshold must be between zero and one")
    self.delegate = delegate
    self.score_threshold = float(score_threshold)

  def retrieve(self, query):
    return self.delegate.retrieve(
      query.model_copy(update={"score_threshold": self.score_threshold})
    )


def build_candidates(dense_retriever, lexical_retriever):
  candidates = {}
  configurations = {}
  for threshold in (0.2, 0.35, 0.5):
    threshold_slug = int(threshold * 100)
    dense_id = f"bge-m3-dense-t{threshold_slug}"
    candidates[dense_id] = QueryThresholdRetriever(dense_retriever, threshold)
    configurations[dense_id] = {
      "strategy": "dense-v1",
      "score_threshold": threshold,
      "fusion_mode": None,
      "dense_weight": None,
      "lexical_weight": None,
      "rrf_k": None,
    }
    fusion_variants = (
      ("hybrid-rrf-v1", "rrf", 1.0, 2.0, "rrf"),
      ("hybrid-score-v1", "dbsf", 2.0, 1.0, "score-fusion-d2-l1"),
      ("hybrid-score-v1", "dbsf", 1.0, 1.0, "score-fusion-d1-l1"),
      ("hybrid-score-v1", "dbsf", 1.0, 2.0, "score-fusion-d1-l2"),
    )
    for strategy, fusion_mode, dense_weight, lexical_weight, slug in fusion_variants:
      candidate_id = f"bge-m3-{slug}-t{threshold_slug}"
      hybrid = HybridRetriever(
        dense_retriever,
        lexical_retriever,
        rrf_k=20,
        dense_rrf_weight=dense_weight,
        lexical_rrf_weight=lexical_weight,
        candidate_multiplier=4,
        fusion_mode=fusion_mode,
      )
      candidates[candidate_id] = QueryThresholdRetriever(hybrid, threshold)
      configurations[candidate_id] = {
        "strategy": strategy,
        "score_threshold": threshold,
        "fusion_mode": fusion_mode,
        "dense_weight": dense_weight,
        "lexical_weight": lexical_weight,
        "rrf_k": 20 if fusion_mode == "rrf" else None,
      }
  return candidates, configurations


def seed_commitment(seed: bytes) -> str:
  if len(seed) != 32:
    raise ValueError("TASK-049 seed must contain exactly 32 bytes")
  return sha256(seed).hexdigest()


def _token(seed: bytes, *parts: object, length: int = 12) -> str:
  material = "\x1f".join(str(part) for part in parts).encode("utf-8")
  return sha256(seed + b"\x00" + material).hexdigest()[:length]


def _document(
  *,
  seed: bytes,
  language: str,
  category: str,
  index: int,
  tenant_id: str,
  project_id: str,
  user_id: str,
  title: str,
  text: str,
  deleted: bool = False,
) -> SourceDocument:
  identity = _token(seed, language, category, index, tenant_id, project_id)
  return SourceDocument(
    document_id=f"task049-{identity}",
    tenant_id=tenant_id,
    project_id=project_id,
    owner_id=user_id,
    source_type="knowledge",
    source_uri=f"https://docs.invalid/{language}/{identity}",
    title=title,
    text=text,
    content_version=f"task049-v1:{sha256(text.encode('utf-8')).hexdigest()}",
    source_sequence=1,
    acl_subjects=[f"user:{user_id}", f"project:{project_id}"],
    deleted=deleted,
  )


def _case(
  *,
  seed: bytes,
  split: str,
  language: str,
  category: str,
  index: int,
  tenant_id: str,
  user_id: str,
  project_id: str,
  task: str,
  relevant: list[SourceDocument] | None = None,
  forbidden: list[SourceDocument] | None = None,
  stale: list[SourceDocument] | None = None,
) -> GoldenCase:
  relevant = relevant or []
  forbidden = forbidden or []
  stale = stale or []
  return GoldenCase(
    dataset_version=f"task049-synthetic-{split}-v1",
    case_id=f"task049-{split}-{language}-{category}-{_token(seed, language, category, index)}",
    tenant_id=tenant_id,
    user_id=user_id,
    project_ids=[project_id],
    query_project_id=project_id,
    language=language,
    split="train" if split == "calibration" else "dev",
    task=task,
    corpus_version=f"task049-synthetic-corpus-{split}-v1",
    index_version=f"task049-synthetic-index-{split}-v1",
    answerability="answerable" if relevant else "no_answer",
    relevant_document_ids=[document.document_id for document in relevant],
    forbidden_document_ids=[document.document_id for document in forbidden],
    stale_document_ids=[document.document_id for document in stale],
    expected_content_versions={
      document.document_id: document.content_version for document in relevant
    },
    tags=["task049-synthetic", f"category:{category}"],
  )


def generate_dataset(seed: bytes, *, split: str) -> Task049Dataset:
  seed_commitment(seed)
  if split not in {"calibration", "validation"}:
    raise ValueError("TASK-049 split must be calibration or validation")
  prefix = _token(seed, split, length=8)
  tenant_id = f"task049-{prefix}-tenant-main"
  other_tenant = f"task049-{prefix}-tenant-other"
  project_id = f"task049-{prefix}-project-main"
  other_project = f"task049-{prefix}-project-other"
  user_id = f"task049-{prefix}-user"
  documents: list[SourceDocument] = []
  cases: list[GoldenCase] = []

  for language in ("pl", "en"):
    concepts = _CONCEPTS[language]
    for category, count in _CATEGORY_COUNTS.items():
      for index in range(count):
        code = f"{language.upper()}-{_token(seed, category, index, length=8).upper()}"
        product = f"Orion-{_token(seed, language, category, index, length=6)}"
        if category == "exact-id":
          title = f"{product} {code}"
          text = (
            f"Procedura {code} opisuje kontrolę modułu {product}."
            if language == "pl" else
            f"Procedure {code} describes the control for module {product}."
          )
          document = _document(
            seed=seed, language=language, category=category, index=index,
            tenant_id=tenant_id, project_id=project_id, user_id=user_id,
            title=title, text=text,
          )
          documents.append(document)
          task = f"Gdzie jest procedura {code}?" if language == "pl" else f"Where is procedure {code}?"
          cases.append(_case(
            seed=seed, split=split, language=language, category=category, index=index,
            tenant_id=tenant_id, user_id=user_id, project_id=project_id,
            task=task, relevant=[document],
          ))
        elif category == "paraphrase":
          concept, paraphrase = concepts[index]
          text = (
            f"Moduł {product}: {concept} wymaga zatwierdzenia właściciela i zapisu wyniku."
            if language == "pl" else
            f"Module {product}: {concept} requires owner approval and a recorded result."
          )
          document = _document(
            seed=seed, language=language, category=category, index=index,
            tenant_id=tenant_id, project_id=project_id, user_id=user_id,
            title=f"{product} — {concept}", text=text,
          )
          documents.append(document)
          task = (
            f"Jak {paraphrase} dla modułu {product}?"
            if language == "pl" else f"How do I {paraphrase} for module {product}?"
          )
          cases.append(_case(
            seed=seed, split=split, language=language, category=category, index=index,
            tenant_id=tenant_id, user_id=user_id, project_id=project_id,
            task=task, relevant=[document],
          ))
        elif category == "lexical-confusable":
          relevant_code = f"{code}-A"
          distractor_code = f"{code}-B"
          relevant = _document(
            seed=seed, language=language, category=category, index=index,
            tenant_id=tenant_id, project_id=project_id, user_id=user_id,
            title=f"{product} {relevant_code}",
            text=f"{relevant_code} primary approved workflow for {product}.",
          )
          distractor = _document(
            seed=seed, language=language, category=f"{category}-distractor", index=index,
            tenant_id=tenant_id, project_id=project_id, user_id=user_id,
            title=f"{product} {distractor_code}",
            text=f"{distractor_code} deprecated diagnostic note for {product}.",
          )
          documents.extend((relevant, distractor))
          task = (
            f"Pokaż zatwierdzony przebieg {relevant_code}."
            if language == "pl" else f"Show the approved workflow {relevant_code}."
          )
          cases.append(_case(
            seed=seed, split=split, language=language, category=category, index=index,
            tenant_id=tenant_id, user_id=user_id, project_id=project_id,
            task=task, relevant=[relevant],
          ))
        elif category == "multi-document":
          first_code = f"{code}-X"
          second_code = f"{code}-Y"
          first = _document(
            seed=seed, language=language, category=f"{category}-x", index=index,
            tenant_id=tenant_id, project_id=project_id, user_id=user_id,
            title=first_code, text=f"{first_code} input requirements for {product}.",
          )
          second = _document(
            seed=seed, language=language, category=f"{category}-y", index=index,
            tenant_id=tenant_id, project_id=project_id, user_id=user_id,
            title=second_code, text=f"{second_code} output verification for {product}.",
          )
          documents.extend((first, second))
          task = (
            f"Znajdź wymagania {first_code} i weryfikację {second_code}."
            if language == "pl" else f"Find requirements {first_code} and verification {second_code}."
          )
          cases.append(_case(
            seed=seed, split=split, language=language, category=category, index=index,
            tenant_id=tenant_id, user_id=user_id, project_id=project_id,
            task=task, relevant=[first, second],
          ))
        elif category == "no-answer-domain":
          task = (
            f"Jaki jest prywatny numer telefonu {code}?"
            if language == "pl" else f"What is the private phone number {code}?"
          )
          cases.append(_case(
            seed=seed, split=split, language=language, category=category, index=index,
            tenant_id=tenant_id, user_id=user_id, project_id=project_id, task=task,
          ))
        else:
          foreign_tenant = other_tenant if category == "no-answer-tenant" else tenant_id
          foreign_project = other_project if category == "no-answer-project" else project_id
          deleted = category == "no-answer-stale"
          document = _document(
            seed=seed, language=language, category=category, index=index,
            tenant_id=foreign_tenant, project_id=foreign_project, user_id=user_id,
            title=code, text=f"Restricted synthetic record {code} for {product}.", deleted=deleted,
          )
          documents.append(document)
          task = f"Znajdź rekord {code}." if language == "pl" else f"Find record {code}."
          cases.append(_case(
            seed=seed, split=split, language=language, category=category, index=index,
            tenant_id=tenant_id, user_id=user_id, project_id=project_id, task=task,
            forbidden=[document] if not deleted else None,
            stale=[document] if deleted else None,
          ))

  rng = random.Random(int.from_bytes(seed, "big"))
  rng.shuffle(cases)
  rng.shuffle(documents)
  return Task049Dataset(tuple(cases), tuple(documents))


def _normalized_query(value: str) -> str:
  return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def assert_no_query_overlap(cases: tuple[GoldenCase, ...], prior_paths: list[Path]) -> None:
  current = {_normalized_query(case.task) for case in cases}
  for path in prior_paths:
    for line in path.read_text(encoding="utf-8").splitlines():
      if not line.strip():
        continue
      value = json.loads(line)
      task = value.get("task")
      if isinstance(task, str) and _normalized_query(task) in current:
        raise ValueError(f"TASK-049 query overlap detected in {path.name}")


def serialize_cases(cases: tuple[GoldenCase, ...]) -> str:
  return "".join(
    json.dumps(case.model_dump(mode="json"), ensure_ascii=False, sort_keys=True) + "\n"
    for case in cases
  )


def serialize_documents(documents: tuple[SourceDocument, ...]) -> str:
  return "".join(
    json.dumps(document.model_dump(mode="json"), ensure_ascii=False, sort_keys=True) + "\n"
    for document in documents
  )


def _absolute_checks(report: dict, policy: dict) -> dict[str, bool]:
  try:
    metrics = report["metrics"]
    global_policy = policy["global"]
    language_policy = policy["languages"]
    safety_policy = policy["safety"]
    latency_policy = policy["latency"]
    checks = {
      "global.recall_at_k_min": metrics["recall_at_k"] >= global_policy["recall_at_k_min"],
      "global.mrr_at_k_min": metrics["mrr"] >= global_policy["mrr_at_k_min"],
      "global.no_answer_accuracy_min": (
        metrics["no_answer_accuracy"] >= global_policy["no_answer_accuracy_min"]
      ),
      "latency.warm_p95_ms_max": (
        metrics["latency_ms"]["p95"] <= latency_policy["warm_p95_ms_max"]
      ),
    }
    for language in ("pl", "en"):
      language_metrics = metrics["by_language"][language]
      checks[f"language_{language}.recall_at_k_min"] = (
        language_metrics["recall_at_k"] >= language_policy["recall_at_k_min"]
      )
      checks[f"language_{language}.mrr_at_k_min"] = (
        language_metrics["mrr"] >= language_policy["mrr_at_k_min"]
      )
    for metric_name, maximum in safety_policy.items():
      report_name = metric_name.removesuffix("_max")
      checks[f"safety.{metric_name}"] = metrics[report_name] <= maximum
    return checks
  except (KeyError, TypeError) as error:
    raise ValueError("invalid TASK-049 metrics or policy") from error


def select_candidate(reports: dict[str, dict], policy: dict) -> str:
  ranked: list[tuple[tuple[float, ...], str]] = []
  for candidate_id, report in reports.items():
    checks = _absolute_checks(report, policy)
    quality_checks = {
      name: passed for name, passed in checks.items()
      if not name.startswith("latency.")
    }
    if not all(quality_checks.values()):
      continue
    metrics = report["metrics"]
    languages = metrics["by_language"]
    score = (
      min(languages["pl"]["recall_at_k"], languages["en"]["recall_at_k"]),
      min(languages["pl"]["mrr"], languages["en"]["mrr"]),
      metrics["no_answer_accuracy"],
      metrics["recall_at_k"],
      metrics["mrr"],
      -metrics["latency_ms"]["p95"],
    )
    ranked.append((score, candidate_id))
  if not ranked:
    raise ValueError("TASK-049 calibration has no candidate passing quality gates")
  return max(ranked, key=lambda item: (item[0], item[1]))[1]


def validation_gate(challenger: dict, incumbent: dict, policy: dict) -> dict:
  checks = _absolute_checks(challenger, policy)
  try:
    candidate_metrics = challenger["metrics"]
    incumbent_metrics = incumbent["metrics"]
    non_inferiority = policy["non_inferiority"]
    checks["global.recall_non_inferiority"] = (
      candidate_metrics["recall_at_k"] - incumbent_metrics["recall_at_k"]
      >= non_inferiority["global_min_delta"]
    )
    checks["global.mrr_non_inferiority"] = (
      candidate_metrics["mrr"] - incumbent_metrics["mrr"]
      >= non_inferiority["global_min_delta"]
    )
    for language in ("pl", "en"):
      for metric_name in ("recall_at_k", "mrr"):
        checks[f"language_{language}.{metric_name}_non_inferiority"] = (
          candidate_metrics["by_language"][language][metric_name]
          - incumbent_metrics["by_language"][language][metric_name]
          >= non_inferiority["language_min_delta"]
        )
    incumbent_p95 = incumbent_metrics["latency_ms"]["p95"]
    checks["latency.incumbent_ratio_max"] = (
      incumbent_p95 > 0
      and candidate_metrics["latency_ms"]["p95"] / incumbent_p95
      <= policy["latency"]["incumbent_ratio_max"]
    )
  except (KeyError, TypeError, ZeroDivisionError) as error:
    raise ValueError("invalid TASK-049 metrics or policy") from error
  return {"passed": all(checks.values()), "checks": checks}


def _without_latency(value):
  if isinstance(value, dict):
    return {
      key: _without_latency(item)
      for key, item in value.items()
      if key not in {"latency_ms", "elapsed_ms"}
    }
  if isinstance(value, list):
    return [_without_latency(item) for item in value]
  return value


def aggregate_repeated_reports(reports: list[dict], *, repetitions: int = 5) -> dict:
  if len(reports) != repetitions:
    raise ValueError(f"TASK-049 validation requires exactly {repetitions} repetitions")
  baseline = _without_latency(reports[0])
  if any(_without_latency(report) != baseline for report in reports[1:]):
    raise ValueError("TASK-049 validation quality drifted between repetitions")
  latencies = [
    float(case["latency_ms"])
    for report in reports
    for case in report["cases"]
    if "latency_ms" in case
  ]
  if not latencies:
    latencies = [float(report["metrics"]["latency_ms"]["p95"]) for report in reports]
  ordered = sorted(latencies)
  metrics = deepcopy(reports[0]["metrics"])
  metrics["latency_ms"] = {
    "p50": ordered[max(0, ceil(0.50 * len(ordered)) - 1)],
    "p95": ordered[max(0, ceil(0.95 * len(ordered)) - 1)],
    "max": ordered[-1],
  }
  return {
    "dataset_version": reports[0]["dataset_version"],
    "mode": reports[0].get("mode", "retrieval_only"),
    "repetition_count": repetitions,
    "metrics": metrics,
    "repetitions": reports,
  }
