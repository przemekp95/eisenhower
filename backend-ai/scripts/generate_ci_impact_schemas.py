#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.ci_impact.artifacts import CiImpactCandidateManifest
from app.ci_impact.classifier import MultilabelLogisticModel
from app.ci_impact.models import DeterministicTargetAdapter, FeatureVector, HistoryRecord, ShadowPlan
from app.ci_impact.promotion import CiImpactPromotionEvidence


SCHEMAS = {
  "candidate-v1.schema.json": CiImpactCandidateManifest,
  "deterministic-adapter-v1.schema.json": DeterministicTargetAdapter,
  "features-v1.schema.json": FeatureVector,
  "history-record-v1.schema.json": HistoryRecord,
  "model-v1.schema.json": MultilabelLogisticModel,
  "promotion-evidence-v1.schema.json": CiImpactPromotionEvidence,
  "shadow-plan-v1.schema.json": ShadowPlan,
}


def main() -> int:
  output = PROJECT_ROOT / "ci-impact/schemas"
  output.mkdir(parents=True, exist_ok=True)
  for filename, model in SCHEMAS.items():
    schema = model.model_json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = f"https://eisenhower.invalid/schemas/{filename}"
    (output / filename).write_text(
      json.dumps(schema, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
