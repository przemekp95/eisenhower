from __future__ import annotations

from collections import defaultdict
from collections import Counter
from pathlib import Path
from typing import Any
from copy import deepcopy
import json
import math
import random
import statistics


CLASS_IDS = (0, 1, 2, 3)


def normalize_text(text: str) -> str:
  return " ".join(text.casefold().split())


def annotation_agreement(
  annotator_a: dict[str, int],
  annotator_b: dict[str, int],
) -> dict[str, Any]:
  """Calculate auditable raw agreement and Cohen's kappa for two blind label sets."""
  if not annotator_a or set(annotator_a) != set(annotator_b):
    raise ValueError("Annotation files must contain the same example ids.")
  for label in [*annotator_a.values(), *annotator_b.values()]:
    if not isinstance(label, int) or isinstance(label, bool) or label not in CLASS_IDS:
      raise ValueError("Annotation quadrants must be integers in range 0..3.")

  example_ids = sorted(annotator_a)
  agreement_count = sum(annotator_a[example_id] == annotator_b[example_id] for example_id in example_ids)
  sample_count = len(example_ids)
  raw_agreement = agreement_count / sample_count
  distribution_a = Counter(annotator_a.values())
  distribution_b = Counter(annotator_b.values())
  expected_agreement = sum(
    (distribution_a[class_id] / sample_count) * (distribution_b[class_id] / sample_count)
    for class_id in CLASS_IDS
  )
  denominator = 1.0 - expected_agreement
  cohen_kappa = (
    (raw_agreement - expected_agreement) / denominator
    if denominator > 1e-12
    else (1.0 if raw_agreement == 1.0 else 0.0)
  )
  return {
    "sample_count": sample_count,
    "agreement_count": agreement_count,
    "raw_agreement": round(raw_agreement, 6),
    "expected_agreement": round(expected_agreement, 6),
    "cohen_kappa": round(cohen_kappa, 6),
    "disagreement_ids": [
      example_id for example_id in example_ids if annotator_a[example_id] != annotator_b[example_id]
    ],
  }


def _require_sha256(value: str, field_name: str) -> str:
  resolved = str(value).strip().lower()
  if len(resolved) != 64 or any(character not in "0123456789abcdef" for character in resolved):
    raise ValueError(f"{field_name} must be a lowercase SHA-256 digest.")
  return resolved


def finalize_dual_annotations(
  pool: list[dict[str, Any]],
  annotator_a: dict[str, int],
  annotator_b: dict[str, int],
  *,
  adjudication: dict[str, int],
  dataset_name: str,
  annotator_a_sha256: str,
  annotator_b_sha256: str,
  pool_sha256: str,
  minimum_examples: int = 240,
  minimum_per_language_class: int = 30,
  minimum_raw_agreement: float = 0.80,
  minimum_kappa: float = 0.80,
) -> dict[str, Any]:
  """Build a pending candidate without pretending that human approval already happened."""
  if len(pool) < minimum_examples:
    raise ValueError(f"Annotation pool must contain at least {minimum_examples} examples.")
  normalized_pool: list[dict[str, Any]] = []
  seen_ids: set[str] = set()
  seen_texts: set[str] = set()
  for item in pool:
    example_id = str(item.get("id", "")).strip()
    language = str(item.get("language", "")).strip()
    text = str(item.get("text", "")).strip()
    if not text:
      task = str(item.get("task", "")).strip()
      context = str(item.get("context", "")).strip()
      text = f"{task}\nContext: {context}" if task and context else ""
    text_key = normalize_text(text)
    if not example_id or example_id in seen_ids:
      raise ValueError("Annotation pool ids must be present and unique.")
    if language not in {"en", "pl"}:
      raise ValueError("Annotation pool language must be 'en' or 'pl'.")
    if not text or text_key in seen_texts:
      raise ValueError("Annotation pool texts must be present and unique.")
    seen_ids.add(example_id)
    seen_texts.add(text_key)
    normalized_pool.append(
      {
        "id": example_id,
        "language": language,
        "text": text,
        "semantic_group_id": str(item.get("semantic_group_id", "")).strip() or example_id,
      }
    )

  if set(annotator_a) != seen_ids or set(annotator_b) != seen_ids:
    raise ValueError("Both annotation files must cover every pool id exactly once.")
  report = annotation_agreement(annotator_a, annotator_b)
  if float(report["raw_agreement"]) < minimum_raw_agreement:
    raise ValueError(
      f"Raw agreement {report['raw_agreement']:.6f} is below the required "
      f"{minimum_raw_agreement:.2f}."
    )
  if float(report["cohen_kappa"]) < minimum_kappa:
    raise ValueError(
      f"Cohen kappa {report['cohen_kappa']:.6f} is below the required {minimum_kappa:.2f}."
    )
  disagreement_ids = set(report["disagreement_ids"])
  if set(adjudication) != disagreement_ids:
    raise ValueError("Adjudication must contain exactly the disagreement ids.")
  if any(
    not isinstance(label, int) or isinstance(label, bool) or label not in CLASS_IDS
    for label in adjudication.values()
  ):
    raise ValueError("Adjudication quadrants must be integers in range 0..3.")

  examples = []
  for item in normalized_pool:
    example_id = item["id"]
    quadrant = (
      adjudication[example_id]
      if example_id in disagreement_ids
      else annotator_a[example_id]
    )
    examples.append({**item, "quadrant": quadrant})

  slice_counts = Counter((item["language"], item["quadrant"]) for item in examples)
  weak_slices = {
    f"{language}:{quadrant}": slice_counts[(language, quadrant)]
    for language in ("en", "pl")
    for quadrant in CLASS_IDS
    if slice_counts[(language, quadrant)] < minimum_per_language_class
  }
  if weak_slices:
    raise ValueError(f"Final language/class slice is underrepresented: {weak_slices}")

  return {
    "name": str(dataset_name).strip() or "production-evaluation-candidate",
    "purpose": "Independent four-class PL/EN production evaluation candidate",
    "label_contract": {"0": "Do Now", "1": "Delegate", "2": "Schedule", "3": "Delete"},
    "governance": {
      "status": "pending_human_approval",
      "provenance": "blind-independent-dual-human-annotation",
      "independent_from_training": True,
      "independent_annotators": 2,
      "inter_annotator_agreement": report["cohen_kappa"],
      "frozen": False,
      "annotation_evidence": {
        **report,
        "annotator_a_sha256": _require_sha256(annotator_a_sha256, "annotator_a_sha256"),
        "annotator_b_sha256": _require_sha256(annotator_b_sha256, "annotator_b_sha256"),
        "pool_sha256": _require_sha256(pool_sha256, "pool_sha256"),
      },
    },
    "examples": examples,
  }


def freeze_evaluation_candidate(
  candidate: dict[str, Any],
  *,
  approver_id: str,
  approved_at: str,
) -> dict[str, Any]:
  """Freeze an already measured candidate only after an explicit human approval record."""
  resolved_approver = str(approver_id).strip()
  resolved_approved_at = str(approved_at).strip()
  if not resolved_approver:
    raise ValueError("A named human approver is required before freezing evaluation data.")
  if not resolved_approved_at:
    raise ValueError("An approval timestamp is required before freezing evaluation data.")
  governance = candidate.get("governance")
  if not isinstance(governance, dict) or governance.get("status") != "pending_human_approval":
    raise ValueError("Only a pending_human_approval candidate can be frozen.")
  frozen = deepcopy(candidate)
  frozen_governance = frozen["governance"]
  frozen_governance.update(
    {
      "status": "approved",
      "frozen": True,
      "approved_by": resolved_approver,
      "approved_at": resolved_approved_at,
      "approval_kind": "human",
    }
  )
  return frozen


def load_evaluation_dataset(path: Path, *, training_texts: list[str]) -> dict[str, Any]:
  payload = json.loads(path.read_text(encoding="utf-8"))
  examples = payload.get("examples")
  if not isinstance(examples, list) or not examples:
    raise ValueError("Evaluation dataset must contain a non-empty examples list.")

  training_keys = {normalize_text(text) for text in training_texts if text.strip()}
  seen_ids: set[str] = set()
  seen_texts: set[str] = set()
  normalized_examples: list[dict[str, Any]] = []
  for item in examples:
    example_id = str(item.get("id", "")).strip()
    language = str(item.get("language", "")).strip()
    text = str(item.get("text", "")).strip()
    quadrant = int(item.get("quadrant", -1))
    text_key = normalize_text(text)
    if not example_id or example_id in seen_ids:
      raise ValueError("Evaluation example ids must be present and unique.")
    if language not in {"en", "pl"}:
      raise ValueError("Evaluation language must be 'en' or 'pl'.")
    if not text or text_key in seen_texts:
      raise ValueError("Evaluation texts must be present and unique.")
    if quadrant not in CLASS_IDS:
      raise ValueError("Evaluation quadrants must be in range 0..3.")
    if text_key in training_keys:
      raise ValueError(f"Evaluation example {example_id} overlaps training data.")
    seen_ids.add(example_id)
    seen_texts.add(text_key)
    semantic_group_id = str(item.get("semantic_group_id", "")).strip() or example_id
    normalized_examples.append(
      {
        "id": example_id,
        "language": language,
        "text": text,
        "quadrant": quadrant,
        "semantic_group_id": semantic_group_id,
      }
    )

  class_distribution = Counter(str(item["quadrant"]) for item in normalized_examples)
  if set(class_distribution) != {str(class_id) for class_id in CLASS_IDS}:
    raise ValueError("Evaluation dataset must represent all four classes.")

  return {
    "name": str(payload.get("name", path.stem)),
    "examples": normalized_examples,
    "governance": dict(payload.get("governance") or {}),
    "language_distribution": dict(Counter(item["language"] for item in normalized_examples)),
    "class_distribution": dict(class_distribution),
  }


def evaluation_governance_issues(
  dataset: dict[str, Any],
  *,
  profile: str = "development",
  minimum_examples: int = 240,
  minimum_per_language_class: int = 30,
  minimum_agreement: float = 0.80,
) -> list[dict[str, Any]]:
  if profile not in {"development", "production"}:
    raise ValueError("Evaluation profile must be 'development' or 'production'.")
  if profile == "development":
    return []

  governance = dataset.get("governance") or {}
  examples = dataset.get("examples") or []
  issues: list[dict[str, Any]] = []
  if governance.get("status") != "approved":
    issues.append({"code": "evaluation_not_approved"})
  if governance.get("independent_from_training") is not True:
    issues.append({"code": "evaluation_not_independent"})
  if governance.get("frozen") is not True:
    issues.append({"code": "evaluation_not_frozen"})
  if int(governance.get("independent_annotators") or 0) < 2:
    issues.append({"code": "insufficient_independent_annotators"})
  agreement = governance.get("inter_annotator_agreement")
  if agreement is None:
    issues.append({"code": "missing_inter_annotator_agreement"})
  elif float(agreement) < minimum_agreement:
    issues.append(
      {
        "code": "inter_annotator_agreement_too_low",
        "actual": float(agreement),
        "minimum": minimum_agreement,
      }
    )
  annotation_evidence = governance.get("annotation_evidence")
  if not isinstance(annotation_evidence, dict):
    issues.append({"code": "missing_annotation_evidence"})
  else:
    evidence_digests = (
      annotation_evidence.get("annotator_a_sha256"),
      annotation_evidence.get("annotator_b_sha256"),
      annotation_evidence.get("pool_sha256"),
    )
    if any(
      not isinstance(digest, str)
      or len(digest) != 64
      or any(character not in "0123456789abcdef" for character in digest.lower())
      for digest in evidence_digests
    ):
      issues.append({"code": "invalid_annotation_evidence_digest"})
    evidence_manifest_digest = annotation_evidence.get("evidence_manifest_sha256")
    if (
      not isinstance(evidence_manifest_digest, str)
      or len(evidence_manifest_digest) != 64
      or any(
        character not in "0123456789abcdef"
        for character in evidence_manifest_digest.lower()
      )
    ):
      issues.append({"code": "invalid_annotation_evidence_manifest_digest"})
    if int(annotation_evidence.get("sample_count") or 0) != len(examples):
      issues.append({"code": "annotation_evidence_sample_count_mismatch"})
    evidence_kappa = annotation_evidence.get("cohen_kappa")
    if evidence_kappa is None or agreement is None or not math.isclose(
      float(evidence_kappa), float(agreement), rel_tol=0.0, abs_tol=1e-6
    ):
      issues.append({"code": "annotation_agreement_evidence_mismatch"})
    evidence_raw_agreement = annotation_evidence.get("raw_agreement")
    if evidence_raw_agreement is None:
      issues.append({"code": "missing_raw_annotation_agreement"})
    elif float(evidence_raw_agreement) < minimum_agreement:
      issues.append(
        {
          "code": "raw_annotation_agreement_too_low",
          "actual": float(evidence_raw_agreement),
          "minimum": minimum_agreement,
        }
      )
  if len(examples) < minimum_examples:
    issues.append(
      {"code": "insufficient_evaluation_examples", "actual": len(examples), "minimum": minimum_examples}
    )

  slice_counts = Counter((str(item.get("language")), int(item.get("quadrant", -1))) for item in examples)
  weak_slices = {
    f"{language}:{quadrant}": slice_counts[(language, quadrant)]
    for language in ("en", "pl")
    for quadrant in CLASS_IDS
    if slice_counts[(language, quadrant)] < minimum_per_language_class
  }
  if weak_slices:
    issues.append(
      {
        "code": "underrepresented_language_class_slice",
        "actual": weak_slices,
        "minimum": minimum_per_language_class,
      }
    )
  return issues


def semantic_leakage_report(
  training_embeddings: list[list[float]],
  evaluation_embeddings: list[list[float]],
  *,
  threshold: float = 0.92,
) -> dict[str, Any]:
  if not 0 <= threshold <= 1:
    raise ValueError("Semantic leakage threshold must be in range 0..1.")
  maximum_similarity = -1.0
  leaking_indices: set[int] = set()
  pairs_above_threshold = 0
  for evaluation_index, evaluation_embedding in enumerate(evaluation_embeddings):
    evaluation_norm = math.sqrt(sum(value * value for value in evaluation_embedding))
    for training_embedding in training_embeddings:
      training_norm = math.sqrt(sum(value * value for value in training_embedding))
      denominator = training_norm * evaluation_norm
      similarity = (
        sum(left * right for left, right in zip(training_embedding, evaluation_embedding)) / denominator
        if denominator
        else 0.0
      )
      maximum_similarity = max(maximum_similarity, similarity)
      if similarity >= threshold:
        pairs_above_threshold += 1
        leaking_indices.add(evaluation_index)
  return {
    "threshold": threshold,
    "maximum_similarity": round(max(maximum_similarity, 0.0), 6),
    "pairs_above_threshold": pairs_above_threshold,
    "leaking_evaluation_indices": sorted(leaking_indices),
  }


def selective_classification_metrics(
  labels: list[int],
  predictions: list[int],
  probabilities: list[list[float]],
  *,
  threshold: float,
) -> dict[str, Any]:
  if not (len(labels) == len(predictions) == len(probabilities)) or not labels:
    raise ValueError("Selective metrics require matching non-empty inputs.")
  accepted_indices = [
    index for index, row in enumerate(probabilities) if max(float(value) for value in row) >= threshold
  ]
  rejected_count = len(labels) - len(accepted_indices)
  accepted_accuracy = None
  accepted_macro_f1 = None
  if accepted_indices:
    accepted_labels = [labels[index] for index in accepted_indices]
    accepted_predictions = [predictions[index] for index in accepted_indices]
    accepted_probabilities = [probabilities[index] for index in accepted_indices]
    metrics = classification_metrics(accepted_labels, accepted_predictions, accepted_probabilities)
    accepted_accuracy = metrics["accuracy"]
    accepted_macro_f1 = metrics["macro_f1"]
  return {
    "threshold": threshold,
    "coverage": round(len(accepted_indices) / len(labels), 6),
    "confirmation_rate": round(rejected_count / len(labels), 6),
    "accepted_count": len(accepted_indices),
    "rejected_count": rejected_count,
    "accepted_accuracy": accepted_accuracy,
    "accepted_macro_f1": accepted_macro_f1,
  }


def aggregate_metric_runs(values: list[float]) -> dict[str, Any]:
  if not values:
    raise ValueError("At least one metric run is required.")
  resolved = [float(value) for value in values]
  return {
    "mean": round(statistics.fmean(resolved), 6),
    "standard_deviation": round(statistics.pstdev(resolved), 6),
    "minimum": round(min(resolved), 6),
    "maximum": round(max(resolved), 6),
    "runs": len(resolved),
  }


def centroid_logits(
  train_embeddings: list[list[float]],
  train_labels: list[int],
  evaluation_embeddings: list[list[float]],
) -> list[list[float]]:
  if not train_embeddings or len(train_embeddings) != len(train_labels):
    raise ValueError("Centroid baseline requires matching non-empty embeddings and labels.")
  dimension = len(train_embeddings[0])
  centroids: dict[int, list[float]] = {}
  for class_id in CLASS_IDS:
    members = [embedding for embedding, label in zip(train_embeddings, train_labels) if label == class_id]
    if not members:
      raise ValueError("Centroid baseline requires every class in training data.")
    centroid = [sum(member[index] for member in members) / len(members) for index in range(dimension)]
    norm = math.sqrt(sum(value * value for value in centroid))
    centroids[class_id] = [value / norm for value in centroid] if norm else centroid

  rows: list[list[float]] = []
  for embedding in evaluation_embeddings:
    embedding_norm = math.sqrt(sum(value * value for value in embedding))
    row = []
    for class_id in CLASS_IDS:
      centroid = centroids[class_id]
      numerator = sum(left * right for left, right in zip(embedding, centroid))
      row.append(numerator / embedding_norm if embedding_norm else 0.0)
    rows.append(row)
  return rows


def stratified_kfold_indices(
  labels: list[int],
  *,
  requested_folds: int = 5,
  seed: int = 7,
) -> list[tuple[list[int], list[int]]]:
  """Return deterministic stratified folds, reducing k when data is scarce."""
  if requested_folds < 2:
    raise ValueError("requested_folds must be at least 2")
  if not labels:
    return []

  by_label: dict[int, list[int]] = defaultdict(list)
  for index, label in enumerate(labels):
    if label not in CLASS_IDS:
      raise ValueError(f"Unsupported class label: {label}")
    by_label[label].append(index)

  if set(by_label) != set(CLASS_IDS):
    return []
  fold_count = min(requested_folds, min(len(indices) for indices in by_label.values()))
  if fold_count < 2:
    return []

  validation_folds: list[list[int]] = [[] for _ in range(fold_count)]
  for label in CLASS_IDS:
    shuffled = list(by_label[label])
    random.Random(seed + label * 1009).shuffle(shuffled)
    for position, index in enumerate(shuffled):
      validation_folds[position % fold_count].append(index)

  all_indices = set(range(len(labels)))
  folds = []
  for validation in validation_folds:
    resolved_validation = sorted(validation)
    train = sorted(all_indices.difference(resolved_validation))
    folds.append((train, resolved_validation))
  return folds


def stratified_group_kfold_indices(
  labels: list[int],
  group_ids: list[str],
  *,
  requested_folds: int = 5,
  seed: int = 7,
) -> list[tuple[list[int], list[int]]]:
  """Create stratified folds without placing one semantic scenario in both sides."""
  if len(labels) != len(group_ids):
    raise ValueError("Labels and semantic group ids must have matching lengths.")
  if requested_folds < 2:
    raise ValueError("requested_folds must be at least 2")
  grouped: dict[str, list[int]] = defaultdict(list)
  for index, group_id in enumerate(group_ids):
    if labels[index] not in CLASS_IDS:
      raise ValueError(f"Unsupported class label: {labels[index]}")
    if not str(group_id).strip():
      raise ValueError("Semantic group ids must not be empty.")
    grouped[str(group_id)].append(index)

  groups_by_label: dict[int, list[str]] = defaultdict(list)
  for group_id, indices in grouped.items():
    group_labels = {labels[index] for index in indices}
    if len(group_labels) != 1:
      raise ValueError(f"Semantic group {group_id!r} spans multiple classes.")
    groups_by_label[next(iter(group_labels))].append(group_id)
  if set(groups_by_label) != set(CLASS_IDS):
    return []
  fold_count = min(requested_folds, min(len(groups) for groups in groups_by_label.values()))
  if fold_count < 2:
    return []

  validation_folds: list[list[int]] = [[] for _ in range(fold_count)]
  for label in CLASS_IDS:
    shuffled = list(groups_by_label[label])
    random.Random(seed + label * 1009).shuffle(shuffled)
    for position, group_id in enumerate(shuffled):
      validation_folds[position % fold_count].extend(grouped[group_id])
  all_indices = set(range(len(labels)))
  return [
    (sorted(all_indices.difference(validation)), sorted(validation))
    for validation in validation_folds
  ]


def softmax_rows(logits: list[list[float]], temperature: float = 1.0) -> list[list[float]]:
  resolved_temperature = max(float(temperature), 1e-6)
  probabilities: list[list[float]] = []
  for row in logits:
    if len(row) != len(CLASS_IDS):
      raise ValueError("Every score row must contain four classes.")
    scaled = [float(value) / resolved_temperature for value in row]
    maximum = max(scaled)
    exponentials = [math.exp(value - maximum) for value in scaled]
    denominator = sum(exponentials)
    probabilities.append([value / denominator for value in exponentials])
  return probabilities


def fit_temperature(logits: list[list[float]], labels: list[int]) -> float:
  """Fit a scalar temperature by deterministic log-space grid search."""
  if not logits or len(logits) != len(labels):
    return 1.0

  # Tiny calibration folds should not be allowed to make a model arbitrarily
  # overconfident. A conservative range regularizes the estimate toward 1.0.
  candidates = [math.exp(math.log(0.5) + index * (math.log(5.0 / 0.5) / 200)) for index in range(201)]
  best_temperature = 1.0
  best_nll = math.inf
  for temperature in candidates:
    probabilities = softmax_rows(logits, temperature=temperature)
    nll = _negative_log_likelihood(labels, probabilities)
    if nll < best_nll:
      best_nll = nll
      best_temperature = temperature
  return float(best_temperature)


def classification_metrics(
  labels: list[int],
  predictions: list[int],
  probabilities: list[list[float]],
  *,
  calibration_bins: int = 10,
) -> dict[str, Any]:
  if not len(labels) == len(predictions) == len(probabilities):
    raise ValueError("Labels, predictions, and probabilities must have equal length.")
  if not labels:
    raise ValueError("At least one evaluation example is required.")

  confusion = [[0 for _ in CLASS_IDS] for _ in CLASS_IDS]
  for expected, predicted in zip(labels, predictions):
    if expected not in CLASS_IDS or predicted not in CLASS_IDS:
      raise ValueError("Labels and predictions must be in range 0..3.")
    confusion[expected][predicted] += 1

  per_class: dict[str, dict[str, float | int]] = {}
  f1_values: list[float] = []
  for class_id in CLASS_IDS:
    true_positive = confusion[class_id][class_id]
    false_positive = sum(confusion[row][class_id] for row in CLASS_IDS if row != class_id)
    false_negative = sum(confusion[class_id][column] for column in CLASS_IDS if column != class_id)
    support = sum(confusion[class_id])
    precision = true_positive / (true_positive + false_positive) if true_positive + false_positive else 0.0
    recall = true_positive / (true_positive + false_negative) if true_positive + false_negative else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    f1_values.append(f1)
    per_class[str(class_id)] = {
      "precision": round(precision, 6),
      "recall": round(recall, 6),
      "f1": round(f1, 6),
      "support": support,
    }

  accuracy = sum(confusion[index][index] for index in CLASS_IDS) / len(labels)
  return {
    "sample_count": len(labels),
    "accuracy": round(accuracy, 6),
    "macro_f1": round(sum(f1_values) / len(CLASS_IDS), 6),
    "per_class": per_class,
    "confusion_matrix": confusion,
    "calibration": {
      "ece": round(_expected_calibration_error(labels, predictions, probabilities, calibration_bins), 6),
      "brier": round(_multiclass_brier(labels, probabilities), 6),
      "nll": round(_negative_log_likelihood(labels, probabilities), 6),
    },
  }


def assess_promotion(
  candidate_metrics: dict[str, Any],
  *,
  baseline_metrics: dict[str, Any] | None = None,
  incumbent_metrics: dict[str, Any] | None = None,
  minimum_macro_f1: float = 0.60,
  maximum_ece: float = 0.25,
  maximum_nll: float = 1.20,
  maximum_brier: float = 0.50,
  minimum_per_class_f1: float = 0.50,
  allowed_regression: float = 0.02,
) -> dict[str, Any]:
  reasons: list[dict[str, Any]] = []
  candidate_f1 = float(candidate_metrics["macro_f1"])
  candidate_ece = float(candidate_metrics["calibration"]["ece"])
  candidate_nll = float(candidate_metrics["calibration"].get("nll", 0.0))
  candidate_brier = float(candidate_metrics["calibration"].get("brier", 0.0))

  if candidate_f1 < minimum_macro_f1:
    reasons.append({"code": "below_minimum_macro_f1", "actual": candidate_f1, "required": minimum_macro_f1})
  if candidate_ece > maximum_ece:
    reasons.append({"code": "calibration_ece_too_high", "actual": candidate_ece, "maximum": maximum_ece})
  if candidate_nll > maximum_nll:
    reasons.append({"code": "calibration_nll_too_high", "actual": candidate_nll, "maximum": maximum_nll})
  if candidate_brier > maximum_brier:
    reasons.append({"code": "calibration_brier_too_high", "actual": candidate_brier, "maximum": maximum_brier})
  weak_classes = {
    class_id: float(metrics["f1"])
    for class_id, metrics in candidate_metrics.get("per_class", {}).items()
    if float(metrics["f1"]) < minimum_per_class_f1
  }
  if weak_classes:
    reasons.append({"code": "per_class_f1_too_low", "actual": weak_classes, "minimum": minimum_per_class_f1})
  if baseline_metrics is not None:
    baseline_f1 = float(baseline_metrics["macro_f1"])
    if candidate_f1 < baseline_f1 - allowed_regression:
      reasons.append({"code": "below_embedding_baseline", "actual": candidate_f1, "reference": baseline_f1})
  if incumbent_metrics is not None:
    incumbent_f1 = float(incumbent_metrics["macro_f1"])
    if candidate_f1 < incumbent_f1 - allowed_regression:
      reasons.append({"code": "regressed_from_incumbent", "actual": candidate_f1, "reference": incumbent_f1})

  return {"passed": not reasons, "reasons": reasons}


def _negative_log_likelihood(labels: list[int], probabilities: list[list[float]]) -> float:
  epsilon = 1e-12
  return -sum(math.log(max(float(row[label]), epsilon)) for label, row in zip(labels, probabilities)) / len(labels)


def _multiclass_brier(labels: list[int], probabilities: list[list[float]]) -> float:
  total = 0.0
  for label, row in zip(labels, probabilities):
    total += sum((float(probability) - (1.0 if class_id == label else 0.0)) ** 2 for class_id, probability in enumerate(row))
  return total / len(labels)


def _expected_calibration_error(
  labels: list[int],
  predictions: list[int],
  probabilities: list[list[float]],
  bin_count: int,
) -> float:
  if bin_count < 1:
    raise ValueError("calibration_bins must be positive.")
  buckets: list[list[tuple[float, bool]]] = [[] for _ in range(bin_count)]
  for label, prediction, row in zip(labels, predictions, probabilities):
    confidence = max(float(value) for value in row)
    bucket_index = min(int(confidence * bin_count), bin_count - 1)
    buckets[bucket_index].append((confidence, prediction == label))

  ece = 0.0
  for bucket in buckets:
    if not bucket:
      continue
    average_confidence = sum(item[0] for item in bucket) / len(bucket)
    accuracy = sum(1 for item in bucket if item[1]) / len(bucket)
    ece += (len(bucket) / len(labels)) * abs(accuracy - average_confidence)
  return ece
