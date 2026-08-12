from __future__ import annotations

from app.ci_impact.classifier import TrainingExample
from app.ci_impact.models import ChangeSet, FeatureVector, HistoryRecord


def require_reviewed_training_labels(
  records: tuple[HistoryRecord, ...], job_ids: tuple[str, ...]
) -> None:
  missing: list[str] = []
  for job in job_ids:
    values = {record.labels[job].value for record in records if job in record.labels}
    if not {"required", "safe_to_skip"}.issubset(values):
      missing.append(job)
  if missing:
    raise ValueError(
      "manual labels require both required and safe_to_skip evidence for: " + ", ".join(missing)
    )


def build_training_examples(
  records_and_features: tuple[tuple[HistoryRecord, FeatureVector], ...],
  job_ids: tuple[str, ...],
) -> tuple[TrainingExample, ...]:
  records = tuple(record for record, _ in records_and_features)
  require_reviewed_training_labels(records, job_ids)
  return tuple(
    TrainingExample(
      features=features.values,
      labels={job: record.labels[job].value for job in job_ids},
    )
    for record, features in records_and_features
  )


def classify_epochs(changes: ChangeSet, features: FeatureVector) -> tuple[str, ...]:
  epochs: list[str] = []
  if features.values.get("dependency.impacted_count", 0) > 0:
    epochs.append("dependency")
  if features.values.get("change.workflow", 0) > 0:
    epochs.append("workflow")
  if features.values.get("change.lockfile", 0) > 0:
    epochs.append("lockfile")
  if any(item.status == "renamed" for item in changes.files):
    epochs.append("rename")
  if any(item.binary for item in changes.files):
    epochs.append("binary")
  if features.unknown_paths:
    epochs.append("unknown_paths")
  if any(item.status == "deleted" for item in changes.files):
    epochs.append("delete")
  return tuple(epochs or ("ordinary",))
