from __future__ import annotations

from hashlib import sha256
import json
import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.ci_impact.models import LabelValue, SHA256_PATTERN, SAFE_JOB_PATTERN


class TrainingExample(BaseModel):
  model_config = ConfigDict(extra="forbid", frozen=True)
  features: dict[str, float]
  labels: dict[str, LabelValue]


class MultilabelLogisticModel(BaseModel):
  """Independent binary heads for CI jobs; not related to the task-quadrant classifier."""

  model_config = ConfigDict(extra="forbid", frozen=True)
  schema_version: Literal["ci-impact-model-v1"] = "ci-impact-model-v1"
  job_ids: tuple[str, ...] = Field(..., min_length=1)
  feature_names: tuple[str, ...] = Field(..., min_length=1)
  weights: dict[str, dict[str, float]]
  biases: dict[str, float]
  training_dataset_sha256: str = Field(..., pattern=SHA256_PATTERN.pattern)
  checksum: str = Field(..., pattern=SHA256_PATTERN.pattern)

  @classmethod
  def create(cls, **values) -> "MultilabelLogisticModel":
    draft = cls.model_construct(schema_version="ci-impact-model-v1", checksum="0" * 64, **values)
    return cls(checksum=draft.compute_checksum(), **values)

  @classmethod
  def train(
    cls,
    *,
    examples: tuple[TrainingExample, ...],
    job_ids: tuple[str, ...],
    dataset_sha256: str,
    epochs: int = 500,
    learning_rate: float = 0.1,
    l2: float = 0.001,
  ) -> "MultilabelLogisticModel":
    if not examples:
      raise ValueError("training requires reviewed examples")
    if not 1 <= epochs <= 100_000 or not 0 < learning_rate <= 1 or not 0 <= l2 <= 1:
      raise ValueError("training hyperparameters are outside the bounded range")
    feature_names = tuple(sorted({name for example in examples for name in example.features}))
    weights = {job: {name: 0.0 for name in feature_names} for job in job_ids}
    biases = {job: 0.0 for job in job_ids}
    for job in job_ids:
      reviewed = [example for example in examples if example.labels.get(job) in {"required", "safe_to_skip"}]
      if not reviewed:
        continue
      for _ in range(epochs):
        weight_gradient = {name: 0.0 for name in feature_names}
        bias_gradient = 0.0
        for example in reviewed:
          target = float(example.labels[job] == "required")
          score = biases[job] + sum(
            weights[job][name] * float(example.features.get(name, 0.0)) for name in feature_names
          )
          error = cls._sigmoid(score) - target
          bias_gradient += error
          for name in feature_names:
            weight_gradient[name] += error * float(example.features.get(name, 0.0))
        count = len(reviewed)
        biases[job] -= learning_rate * bias_gradient / count
        for name in feature_names:
          regularized = weight_gradient[name] / count + l2 * weights[job][name]
          weights[job][name] -= learning_rate * regularized
    return cls.create(
      job_ids=job_ids,
      feature_names=feature_names,
      weights=weights,
      biases=biases,
      training_dataset_sha256=dataset_sha256,
    )

  @model_validator(mode="after")
  def validate_contract(self):
    if len(set(self.job_ids)) != len(self.job_ids) or any(not SAFE_JOB_PATTERN.fullmatch(job) for job in self.job_ids):
      raise ValueError("model job identifiers are invalid")
    if len(set(self.feature_names)) != len(self.feature_names):
      raise ValueError("model feature schema contains duplicates")
    if set(self.weights) != set(self.job_ids) or set(self.biases) != set(self.job_ids):
      raise ValueError("model heads must match the exact job universe")
    if any(set(head) != set(self.feature_names) for head in self.weights.values()):
      raise ValueError("model weights must match the exact feature schema")
    numbers = [*self.biases.values(), *(value for head in self.weights.values() for value in head.values())]
    if any(not math.isfinite(value) for value in numbers):
      raise ValueError("model contains non-finite parameters")
    if self.checksum != self.compute_checksum():
      raise ValueError("model checksum mismatch")
    return self

  def canonical_payload(self) -> dict:
    return self.model_dump(mode="json", exclude={"checksum"})

  def compute_checksum(self) -> str:
    payload = json.dumps(self.canonical_payload(), sort_keys=True, separators=(",", ":"))
    return sha256(payload.encode()).hexdigest()

  def predict(self, features: dict[str, float]) -> dict[str, float]:
    if set(features) != set(self.feature_names):
      raise ValueError("feature schema mismatch")
    if any(not math.isfinite(float(value)) for value in features.values()):
      raise ValueError("features contain non-finite values")
    return {
      job: self._sigmoid(
        self.biases[job] + sum(self.weights[job][name] * float(features[name]) for name in self.feature_names)
      )
      for job in self.job_ids
    }

  @staticmethod
  def _sigmoid(value: float) -> float:
    if value >= 0:
      denominator = 1 + math.exp(-min(value, 700))
      return 1 / denominator
    exponential = math.exp(max(value, -700))
    return exponential / (1 + exponential)
