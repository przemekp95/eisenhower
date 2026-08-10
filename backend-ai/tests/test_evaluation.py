import math

from app.evaluation import (
  aggregate_metric_runs,
  assess_promotion,
  centroid_logits,
  classification_metrics,
  evaluation_governance_issues,
  fit_temperature,
  load_evaluation_dataset,
  selective_classification_metrics,
  semantic_leakage_report,
  softmax_rows,
  stratified_group_kfold_indices,
  stratified_kfold_indices,
)


def test_stratified_folds_are_seeded_disjoint_and_cover_every_example_once():
  labels = [0] * 5 + [1] * 5 + [2] * 5 + [3] * 5

  folds = stratified_kfold_indices(labels, requested_folds=5, seed=19)

  assert len(folds) == 5
  validation_indices = [index for _, validation in folds for index in validation]
  assert sorted(validation_indices) == list(range(len(labels)))
  assert len(validation_indices) == len(set(validation_indices))
  for train, validation in folds:
    assert set(train).isdisjoint(validation)
    assert {labels[index] for index in validation} == {0, 1, 2, 3}
  assert folds == stratified_kfold_indices(labels, requested_folds=5, seed=19)
  assert folds != stratified_kfold_indices(labels, requested_folds=5, seed=23)


def test_stratified_folds_reduce_fold_count_instead_of_dropping_a_class():
  labels = [0, 0, 1, 1, 2, 2, 3, 3]

  folds = stratified_kfold_indices(labels, requested_folds=5, seed=7)

  assert len(folds) == 2
  assert all({labels[index] for index in validation} == {0, 1, 2, 3} for _, validation in folds)


def test_grouped_stratified_folds_never_split_bilingual_scenario_pairs():
  labels = [class_id for class_id in range(4) for _ in range(6)]
  groups = [f"scenario-{class_id}-{pair}" for class_id in range(4) for pair in range(3) for _ in range(2)]

  folds = stratified_group_kfold_indices(labels, groups, requested_folds=3, seed=19)

  assert len(folds) == 3
  for train, validation in folds:
    assert {groups[index] for index in train}.isdisjoint(groups[index] for index in validation)
    assert {labels[index] for index in validation} == {0, 1, 2, 3}


def test_grouped_stratification_rejects_a_group_with_conflicting_classes():
  try:
    stratified_group_kfold_indices([0, 1, 2, 2, 3, 3], ["same", "same", "2a", "2b", "3a", "3b"])
  except ValueError as issue:
    assert "spans multiple classes" in str(issue)
  else:
    raise AssertionError("Expected conflicting semantic group to be rejected")


def test_metrics_report_macro_per_class_confusion_and_calibration():
  labels = [0, 0, 1, 1, 2, 2, 3, 3]
  predictions = [0, 1, 1, 1, 2, 0, 3, 2]
  probabilities = [
    [0.8, 0.1, 0.05, 0.05],
    [0.1, 0.7, 0.1, 0.1],
    [0.1, 0.75, 0.1, 0.05],
    [0.1, 0.65, 0.2, 0.05],
    [0.05, 0.1, 0.8, 0.05],
    [0.7, 0.1, 0.15, 0.05],
    [0.05, 0.05, 0.1, 0.8],
    [0.05, 0.1, 0.75, 0.1],
  ]

  metrics = classification_metrics(labels, predictions, probabilities)

  assert metrics["sample_count"] == 8
  assert metrics["accuracy"] == 0.625
  assert 0 < metrics["macro_f1"] < 1
  assert set(metrics["per_class"]) == {"0", "1", "2", "3"}
  assert metrics["confusion_matrix"][0] == [1, 1, 0, 0]
  assert 0 <= metrics["calibration"]["ece"] <= 1
  assert metrics["calibration"]["brier"] > 0
  assert metrics["calibration"]["nll"] > 0


def test_temperature_fitting_never_worsens_nll_on_its_calibration_sample():
  logits = [[5.0, 0.0, 0.0, 0.0], [0.0, 5.0, 0.0, 0.0], [5.0, 0.0, 0.0, 0.0], [0.0, 5.0, 0.0, 0.0]]
  labels = [0, 1, 1, 0]

  temperature = fit_temperature(logits, labels)
  raw = classification_metrics(labels, [0, 1, 0, 1], softmax_rows(logits))["calibration"]["nll"]
  calibrated_probabilities = softmax_rows(logits, temperature=temperature)
  calibrated_predictions = [max(range(4), key=row.__getitem__) for row in calibrated_probabilities]
  calibrated = classification_metrics(labels, calibrated_predictions, calibrated_probabilities)["calibration"]["nll"]

  assert math.isfinite(temperature)
  assert 0.5 <= temperature <= 5.0
  assert calibrated <= raw


def test_quality_gate_requires_absolute_quality_calibration_and_no_regression():
  baseline = {"macro_f1": 0.61, "calibration": {"ece": 0.18}}
  incumbent = {"macro_f1": 0.64, "calibration": {"ece": 0.16}}

  passing = assess_promotion(
    {"macro_f1": 0.66, "calibration": {"ece": 0.17}},
    baseline_metrics=baseline,
    incumbent_metrics=incumbent,
    minimum_macro_f1=0.60,
    maximum_ece=0.25,
    allowed_regression=0.02,
  )
  failing = assess_promotion(
    {"macro_f1": 0.58, "calibration": {"ece": 0.30, "nll": 1.4, "brier": 0.6}},
    baseline_metrics=baseline,
    incumbent_metrics=incumbent,
    minimum_macro_f1=0.60,
    maximum_ece=0.25,
    allowed_regression=0.02,
  )

  assert passing["passed"] is True
  assert passing["reasons"] == []
  assert failing["passed"] is False
  assert {reason["code"] for reason in failing["reasons"]} == {
    "below_minimum_macro_f1",
    "calibration_ece_too_high",
    "calibration_nll_too_high",
    "calibration_brier_too_high",
    "below_embedding_baseline",
    "regressed_from_incumbent",
  }


def test_centroid_baseline_scores_all_four_direct_classes():
  train_embeddings = [[1.0, 0.0], [0.9, 0.1], [0.0, 1.0], [0.1, 0.9], [-1.0, 0.0], [-0.9, -0.1], [0.0, -1.0], [-0.1, -0.9]]
  train_labels = [0, 0, 1, 1, 2, 2, 3, 3]

  logits = centroid_logits(train_embeddings, train_labels, [[0.95, 0.05], [-0.95, -0.05]])

  assert len(logits) == 2
  assert all(len(row) == 4 for row in logits)
  assert max(range(4), key=logits[0].__getitem__) == 0
  assert max(range(4), key=logits[1].__getitem__) == 2


def test_quality_gate_rejects_a_model_that_hides_one_weak_class_behind_macro_average():
  metrics = {
    "macro_f1": 0.70,
    "per_class": {"0": {"f1": 0.9}, "1": {"f1": 0.3}, "2": {"f1": 0.8}, "3": {"f1": 0.8}},
    "calibration": {"ece": 0.1, "nll": 0.7, "brier": 0.3},
  }

  gate = assess_promotion(metrics, minimum_per_class_f1=0.5)

  assert gate["passed"] is False
  assert gate["reasons"] == [
    {"code": "per_class_f1_too_low", "actual": {"1": 0.3}, "minimum": 0.5}
  ]


def test_standalone_eval_loader_rejects_training_leakage_and_reports_language_slices(tmp_path):
  dataset_path = tmp_path / "eval.json"
  dataset_path.write_text(
    '{"name":"eval-v1","examples":['
    '{"id":"en-0","language":"en","text":"urgent fix","quadrant":0},'
    '{"id":"pl-1","language":"pl","text":"deleguj raport","quadrant":1},'
    '{"id":"en-2","language":"en","text":"plan health","quadrant":2},'
    '{"id":"pl-3","language":"pl","text":"usuń spam","quadrant":3}'
    ']}',
    encoding="utf-8",
  )

  loaded = load_evaluation_dataset(dataset_path, training_texts=["different task"])
  assert loaded["name"] == "eval-v1"
  assert loaded["language_distribution"] == {"en": 2, "pl": 2}
  assert loaded["class_distribution"] == {"0": 1, "1": 1, "2": 1, "3": 1}

  try:
    load_evaluation_dataset(dataset_path, training_texts=[" URGENT   FIX "])
  except ValueError as issue:
    assert "overlaps training data" in str(issue)
  else:
    raise AssertionError("Expected train/evaluation leakage to be rejected")


def test_production_evaluation_governance_fails_closed_without_independent_approval():
  dataset = {
    "name": "synthetic-v1",
    "examples": [
      {"id": f"{language}-{quadrant}-{index}", "language": language, "text": "x", "quadrant": quadrant}
      for language in ("en", "pl")
      for quadrant in range(4)
      for index in range(4)
    ],
    "governance": {
      "status": "development",
      "provenance": "synthetic",
      "independent_from_training": False,
      "independent_annotators": 0,
      "inter_annotator_agreement": None,
      "frozen": False,
    },
  }

  issues = evaluation_governance_issues(dataset, profile="production")

  assert {issue["code"] for issue in issues} == {
    "evaluation_not_approved",
    "evaluation_not_independent",
    "evaluation_not_frozen",
    "insufficient_independent_annotators",
    "missing_inter_annotator_agreement",
    "missing_annotation_evidence",
    "insufficient_evaluation_examples",
    "underrepresented_language_class_slice",
  }


def test_production_evaluation_governance_accepts_a_large_frozen_dual_annotated_set():
  dataset = {
    "name": "blind-human-v1",
    "examples": [
      {"id": f"{language}-{quadrant}-{index}", "language": language, "text": f"task {index}", "quadrant": quadrant}
      for language in ("en", "pl")
      for quadrant in range(4)
      for index in range(30)
    ],
    "governance": {
      "status": "approved",
      "provenance": "anonymized-production-tasks",
      "independent_from_training": True,
      "independent_annotators": 2,
      "inter_annotator_agreement": 0.85,
      "annotation_evidence": {
        "sample_count": 240,
        "raw_agreement": 0.9,
        "cohen_kappa": 0.85,
        "annotator_a_sha256": "a" * 64,
        "annotator_b_sha256": "b" * 64,
        "pool_sha256": "c" * 64,
      },
      "frozen": True,
    },
  }

  assert evaluation_governance_issues(dataset, profile="production") == []


def test_semantic_leakage_report_flags_near_duplicates_not_only_exact_text():
  report = semantic_leakage_report(
    [[1.0, 0.0], [0.0, 1.0]],
    [[0.99, 0.01], [-1.0, 0.0]],
    threshold=0.95,
  )

  assert report["pairs_above_threshold"] == 1
  assert report["maximum_similarity"] > 0.99
  assert report["leaking_evaluation_indices"] == [0]


def test_selective_metrics_measure_coverage_and_accuracy_after_confirmation_threshold():
  labels = [0, 1, 2, 3]
  probabilities = [
    [0.8, 0.1, 0.05, 0.05],
    [0.4, 0.35, 0.15, 0.1],
    [0.1, 0.1, 0.7, 0.1],
    [0.1, 0.1, 0.15, 0.65],
  ]
  predictions = [0, 0, 2, 3]

  report = selective_classification_metrics(labels, predictions, probabilities, threshold=0.6)

  assert report["coverage"] == 0.75
  assert report["confirmation_rate"] == 0.25
  assert report["accepted_accuracy"] == 1.0
  assert report["accepted_count"] == 3
  assert report["rejected_count"] == 1


def test_metric_run_aggregation_reports_variance_and_worst_seed():
  aggregate = aggregate_metric_runs([0.7, 0.8, 0.9])

  assert aggregate == {
    "mean": 0.8,
    "standard_deviation": 0.08165,
    "minimum": 0.7,
    "maximum": 0.9,
    "runs": 3,
  }
