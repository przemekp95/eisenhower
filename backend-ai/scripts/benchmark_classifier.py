#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from typing import Any
import argparse
import hashlib
import json
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.config import load_settings
from app.evaluation import (
  assess_promotion,
  aggregate_metric_runs,
  centroid_logits,
  classification_metrics,
  evaluation_governance_issues,
  fit_temperature,
  load_evaluation_dataset,
  selective_classification_metrics,
  semantic_leakage_report,
  softmax_rows,
  stratified_group_kfold_indices,
)
from app.local_model import LocalMiniLMClassifier, clean_training_records, three_way_split_indices
from app.store import TrainingStore


def train_mlp_head(
  torch: Any,
  settings: Any,
  embeddings: list[list[float]],
  labels: list[int],
  fit_indices: list[int],
  stopping_indices: list[int],
  *,
  seed: int,
):
  torch.manual_seed(seed)
  head = torch.nn.Sequential(
    torch.nn.Linear(len(embeddings[0]), settings.local_model_hidden_dim),
    torch.nn.GELU(),
    torch.nn.Dropout(settings.local_model_dropout),
    torch.nn.Linear(settings.local_model_hidden_dim, 4),
  )
  optimizer = torch.optim.AdamW(head.parameters(), lr=settings.local_model_learning_rate)
  criterion = torch.nn.CrossEntropyLoss()
  embedding_tensor = torch.tensor(embeddings, dtype=torch.float32)
  label_tensor = torch.tensor(labels, dtype=torch.long)
  best_state = {key: value.detach().clone() for key, value in head.state_dict().items()}
  best_loss = float("inf")
  patience_left = settings.local_model_patience

  for _ in range(settings.local_model_epochs):
    head.train()
    optimizer.zero_grad()
    loss = criterion(head(embedding_tensor[fit_indices]), label_tensor[fit_indices])
    loss.backward()
    optimizer.step()

    measured_loss = float(loss.detach().item())
    if stopping_indices:
      head.eval()
      with torch.no_grad():
        measured_loss = float(
          criterion(head(embedding_tensor[stopping_indices]), label_tensor[stopping_indices]).item()
        )
    if measured_loss < best_loss - 1e-4:
      best_loss = measured_loss
      best_state = {key: value.detach().clone() for key, value in head.state_dict().items()}
      patience_left = settings.local_model_patience
    else:
      patience_left -= 1
      if patience_left <= 0:
        break

  head.load_state_dict(best_state)
  return head.eval()


def head_logits(torch: Any, head: Any, embeddings: list[list[float]]) -> list[list[float]]:
  if not embeddings:
    return []
  with torch.no_grad():
    return [[float(value) for value in row] for row in head(torch.tensor(embeddings, dtype=torch.float32)).tolist()]


def metrics_with_slices(
  labels: list[int],
  probabilities: list[list[float]],
  languages: list[str] | None = None,
) -> dict[str, Any]:
  predictions = [max(range(4), key=row.__getitem__) for row in probabilities]
  metrics = classification_metrics(labels, predictions, probabilities)
  if languages:
    metrics["by_language"] = {}
    for language in sorted(set(languages)):
      indices = [index for index, candidate in enumerate(languages) if candidate == language]
      metrics["by_language"][language] = classification_metrics(
        [labels[index] for index in indices],
        [predictions[index] for index in indices],
        [probabilities[index] for index in indices],
      )
  return metrics


def evaluation_sha256(path: Path) -> str:
  return hashlib.sha256(path.read_bytes()).hexdigest()


def evaluation_approval_issues(
  actual_sha256: str,
  approved_sha256: str | None,
) -> list[dict[str, Any]]:
  if approved_sha256 is None:
    return [{"code": "approved_evaluation_sha256_missing", "actual": actual_sha256}]
  if actual_sha256 != approved_sha256:
    return [
      {
        "code": "approved_evaluation_sha256_mismatch",
        "actual": actual_sha256,
        "required": approved_sha256,
      }
    ]
  return []


def merge_production_reasons(
  production_reasons: list[dict[str, Any]],
  development_gate: dict[str, Any],
) -> list[dict[str, Any]]:
  """Make every failed model-quality gate part of the production decision."""
  merged = list(production_reasons)
  for reason in development_gate.get("reasons", []):
    if reason not in merged:
      merged.append(reason)
  return merged


def evaluate_incumbent(
  model: Any,
  *,
  records: list[dict[str, Any]],
  evaluation_embeddings: list[list[float]],
  evaluation_labels: list[int],
  evaluation_languages: list[str],
) -> tuple[dict[str, Any], dict[str, Any] | None]:
  if not (model.head_path.exists() and model.meta_path.exists() and model.index_path.exists()):
    return {"available": False, "reason": "incumbent_artifact_missing"}, None
  try:
    model._load_artifacts(expected_records=records)
    logits = model._logits_for_head(model._head, evaluation_embeddings)
    probabilities = softmax_rows(logits, temperature=model._temperature)
    metrics = metrics_with_slices(evaluation_labels, probabilities, evaluation_languages)
    return {
      "available": True,
      "generation_id": model.status().get("generation_id"),
      "metrics": metrics,
    }, metrics
  except Exception as issue:  # fail closed while preserving an actionable benchmark report
    return {
      "available": False,
      "reason": "incumbent_artifact_invalid",
      "detail": str(issue),
    }, None


def conservative_training_group_ids(records: list[dict[str, Any]]) -> list[str]:
  """Pair same-position PL/EN examples so likely translations never cross CV folds."""
  positions: dict[tuple[int, str], int] = {}
  result: list[str] = []
  for index, record in enumerate(records):
    explicit = str(record.get("semantic_group_id", "")).strip()
    if explicit:
      result.append(explicit)
      continue
    language = str(record.get("language", "unknown"))
    key = (int(record["quadrant"]), language)
    position = positions.get(key, 0)
    positions[key] = position + 1
    result.append(f"paired-{record['quadrant']}-{position}" if language in {"en", "pl"} else f"item-{index}")
  return result


def run_benchmark() -> dict[str, Any]:
  settings = load_settings()
  store = TrainingStore(settings.training_data_path)
  records = clean_training_records(store.load())
  texts = [record["text"] for record in records]
  labels = [int(record["quadrant"]) for record in records]
  group_ids = conservative_training_group_ids(records)
  dataset = load_evaluation_dataset(settings.evaluation_data_path, training_texts=texts)  # type: ignore[arg-type]
  dataset_sha256 = evaluation_sha256(settings.evaluation_data_path)  # type: ignore[arg-type]

  model = LocalMiniLMClassifier(settings=settings)
  embeddings = model._encode(texts)
  evaluation_embeddings = model._encode([item["text"] for item in dataset["examples"]])
  evaluation_labels = [int(item["quadrant"]) for item in dataset["examples"]]
  evaluation_languages = [item["language"] for item in dataset["examples"]]
  torch = model._require_torch()
  incumbent_report, incumbent_metrics = evaluate_incumbent(
    model,
    records=records,
    evaluation_embeddings=evaluation_embeddings,
    evaluation_labels=evaluation_labels,
    evaluation_languages=evaluation_languages,
  )

  fold_reports = []
  mlp_oof: dict[int, list[float]] = {}
  centroid_oof: dict[int, list[float]] = {}
  folds = stratified_group_kfold_indices(labels, group_ids, requested_folds=5, seed=7)
  for fold_number, (outer_train, outer_validation) in enumerate(folds):
    outer_train_labels = [labels[index] for index in outer_train]
    inner_fit_relative, inner_stopping_relative, inner_calibration_relative, _ = three_way_split_indices(
      outer_train_labels, seed=100 + fold_number
    )
    inner_fit = [outer_train[index] for index in inner_fit_relative]
    inner_stopping = [outer_train[index] for index in inner_stopping_relative]
    inner_calibration = [outer_train[index] for index in inner_calibration_relative]
    head = train_mlp_head(
      torch,
      settings,
      embeddings,
      labels,
      inner_fit,
      inner_stopping,
      seed=100 + fold_number,
    )
    mlp_temperature = fit_temperature(
      head_logits(torch, head, [embeddings[index] for index in inner_calibration]),
      [labels[index] for index in inner_calibration],
    ) if inner_calibration else 1.0
    mlp_probabilities = softmax_rows(
      head_logits(torch, head, [embeddings[index] for index in outer_validation]),
      temperature=mlp_temperature,
    )

    centroid_temperature = 1.0
    if inner_calibration:
      centroid_temperature = fit_temperature(
        centroid_logits(
          [embeddings[index] for index in inner_fit],
          [labels[index] for index in inner_fit],
          [embeddings[index] for index in inner_calibration],
        ),
        [labels[index] for index in inner_calibration],
      )
    centroid_probabilities = softmax_rows(
      centroid_logits(
        [embeddings[index] for index in outer_train],
        [labels[index] for index in outer_train],
        [embeddings[index] for index in outer_validation],
      ),
      temperature=centroid_temperature,
    )
    for index, probability in zip(outer_validation, mlp_probabilities):
      mlp_oof[index] = probability
    for index, probability in zip(outer_validation, centroid_probabilities):
      centroid_oof[index] = probability
    fold_reports.append({"fold": fold_number + 1, "train": len(outer_train), "validation": len(outer_validation)})

  mlp_cv_probabilities = [mlp_oof[index] for index in range(len(labels))]
  centroid_cv_probabilities = [centroid_oof[index] for index in range(len(labels))]

  seed_reports: list[dict[str, Any]] = []
  seed_probabilities: dict[int, list[list[float]]] = {}
  for seed in (7, 19, 31, 43, 59):
    final_fit, final_stopping, final_calibration, _ = three_way_split_indices(labels, seed=seed)
    final_head = train_mlp_head(torch, settings, embeddings, labels, final_fit, final_stopping, seed=seed)
    final_temperature = fit_temperature(
      head_logits(torch, final_head, [embeddings[index] for index in final_calibration]),
      [labels[index] for index in final_calibration],
    ) if final_calibration else 1.0
    probabilities = softmax_rows(
      head_logits(torch, final_head, evaluation_embeddings), temperature=final_temperature
    )
    seed_probabilities[seed] = probabilities
    seed_reports.append(
      {
        "seed": seed,
        "temperature": round(final_temperature, 6),
        "metrics": metrics_with_slices(evaluation_labels, probabilities, evaluation_languages),
      }
    )
  mlp_eval_probabilities = seed_probabilities[7]
  final_fit, _, final_calibration, _ = three_way_split_indices(labels, seed=7)
  final_temperature = seed_reports[0]["temperature"]

  centroid_temperature = fit_temperature(
    centroid_logits(
      [embeddings[index] for index in final_fit],
      [labels[index] for index in final_fit],
      [embeddings[index] for index in final_calibration],
    ),
    [labels[index] for index in final_calibration],
  ) if final_calibration else 1.0
  centroid_eval_probabilities = softmax_rows(
    centroid_logits(embeddings, labels, evaluation_embeddings),
    temperature=centroid_temperature,
  )

  mlp_eval_metrics = metrics_with_slices(evaluation_labels, mlp_eval_probabilities, evaluation_languages)
  centroid_eval_metrics = metrics_with_slices(evaluation_labels, centroid_eval_probabilities, evaluation_languages)
  gate = assess_promotion(
    mlp_eval_metrics,
    baseline_metrics=centroid_eval_metrics,
    incumbent_metrics=incumbent_metrics,
    minimum_macro_f1=settings.local_model_minimum_macro_f1,
    maximum_ece=settings.local_model_maximum_ece,
    maximum_nll=settings.local_model_maximum_nll,
    maximum_brier=settings.local_model_maximum_brier,
    minimum_per_class_f1=settings.local_model_minimum_per_class_f1,
    allowed_regression=settings.local_model_allowed_regression,
  )
  stability = aggregate_metric_runs([report["metrics"]["macro_f1"] for report in seed_reports])
  if stability["minimum"] < settings.local_model_minimum_worst_seed_macro_f1:
    gate["reasons"].append(
      {
        "code": "worst_seed_macro_f1_too_low",
        "actual": stability["minimum"],
        "minimum": settings.local_model_minimum_worst_seed_macro_f1,
      }
    )
  if stability["standard_deviation"] > settings.local_model_maximum_seed_standard_deviation:
    gate["reasons"].append(
      {
        "code": "seed_instability_too_high",
        "actual": stability["standard_deviation"],
        "maximum": settings.local_model_maximum_seed_standard_deviation,
      }
    )
  gate["passed"] = not gate["reasons"]
  seed7_predictions = [max(range(4), key=row.__getitem__) for row in mlp_eval_probabilities]
  selective = selective_classification_metrics(
    evaluation_labels,
    seed7_predictions,
    mlp_eval_probabilities,
    threshold=settings.local_model_confidence_threshold,
  )
  semantic_leakage = semantic_leakage_report(
    embeddings,
    evaluation_embeddings,
    threshold=settings.local_model_semantic_leakage_threshold,
  )
  production_reasons = evaluation_governance_issues(dataset, profile="production")
  production_reasons.extend(
    evaluation_approval_issues(dataset_sha256, settings.local_model_approved_evaluation_sha256)
  )
  if not incumbent_report["available"]:
    production_reasons.append({"code": incumbent_report["reason"]})
  if semantic_leakage["pairs_above_threshold"] > settings.local_model_maximum_semantic_leaks:
    production_reasons.append({"code": "semantic_evaluation_leakage", "actual": semantic_leakage["pairs_above_threshold"]})
  if stability["minimum"] < 0.75:
    production_reasons.append({"code": "worst_seed_macro_f1_too_low", "actual": stability["minimum"], "minimum": 0.75})
  worst_per_class = {
    str(class_id): min(float(report["metrics"]["per_class"][str(class_id)]["f1"]) for report in seed_reports)
    for class_id in range(4)
  }
  weak_seed_classes = {class_id: value for class_id, value in worst_per_class.items() if value < 0.72}
  if weak_seed_classes:
    production_reasons.append({"code": "worst_seed_per_class_f1_too_low", "actual": weak_seed_classes, "minimum": 0.72})
  if selective["coverage"] < 0.70 or selective["accepted_accuracy"] is None or selective["accepted_accuracy"] < 0.90:
    production_reasons.append(
      {"code": "selective_operating_point_not_met", "actual": selective, "minimum_accuracy": 0.90, "minimum_coverage": 0.70}
    )
  production_reasons = merge_production_reasons(production_reasons, gate)
  return {
    "scope": "local",
    "contract": {"0": "Do Now", "1": "Delegate", "2": "Schedule", "3": "Delete"},
    "encoder": {
      "name": settings.local_model_name,
      "revision": settings.local_model_revision,
    },
    "training_examples": len(records),
    "evaluation_dataset": dataset["name"],
    "evaluation_sha256": dataset_sha256,
    "evaluation_examples": len(dataset["examples"]),
    "cross_validation": {
      "strategy": "semantic-grouped stratified 5-fold with disjoint early-stopping and calibration splits",
      "folds": fold_reports,
      "mlp": metrics_with_slices(labels, mlp_cv_probabilities),
      "centroid": metrics_with_slices(labels, centroid_cv_probabilities),
    },
    "held_out_evaluation": {
      "mlp": mlp_eval_metrics,
      "centroid": centroid_eval_metrics,
      "incumbent": incumbent_report,
      "mlp_temperature": round(final_temperature, 6),
      "centroid_temperature": round(centroid_temperature, 6),
      "multi_seed": seed_reports,
      "macro_f1_stability": stability,
    },
    "evaluation_status": "development smoke set; not canonical production evidence",
    "development_promotion_gate": gate,
    "semantic_leakage": semantic_leakage,
    "selective_operating_point": selective,
    "production_readiness": {"passed": not production_reasons, "reasons": production_reasons},
  }


def main() -> int:
  parser = argparse.ArgumentParser(description="Benchmark the direct four-class local Eisenhower classifier.")
  parser.add_argument("--output", type=Path, help="Optional JSON report path.")
  args = parser.parse_args()
  report = run_benchmark()
  serialized = json.dumps(report, ensure_ascii=False, indent=2)
  print(serialized)
  if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(serialized + "\n", encoding="utf-8")
  selected_gate = (
    report["production_readiness"]
    if load_settings().local_model_evaluation_profile == "production"
    else report["development_promotion_gate"]
  )
  return 0 if selected_gate["passed"] else 2


if __name__ == "__main__":
  raise SystemExit(main())
