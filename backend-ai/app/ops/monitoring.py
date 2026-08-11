from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256
import json
import math
import platform
from typing import Any

from app.artifacts.models import CandidateManifest, GitLineage, LineageGroup, RuntimeLineage
from app.artifacts.registry import ImmutableArtifactRegistry


PHASES = ("classifier", "retrieval", "generation", "response", "mag")
SENSITIVE_FRAGMENTS = (
  "prompt",
  "token",
  "user_id",
  "tenant_id",
  "email",
  "private_identifier",
  "content",
  "text",
  "citation",
)


class MonitoringContractError(RuntimeError):
  """Raised when a quality report could expose sensitive or malformed data."""


def _finite_number(value: Any, *, field: str) -> float:
  if isinstance(value, bool):
    raise MonitoringContractError(f"{field} must be a finite numeric value")
  try:
    number = float(value)
  except (TypeError, ValueError) as issue:
    raise MonitoringContractError(f"{field} must be a finite numeric value") from issue
  if not math.isfinite(number):
    raise MonitoringContractError(f"{field} must be a finite numeric value")
  return number


def _reject_sensitive_fields(value: Any, path: tuple[str, ...] = ()) -> None:
  if isinstance(value, dict):
    for key, nested in value.items():
      normalized = str(key).casefold()
      if any(fragment in normalized for fragment in SENSITIVE_FRAGMENTS):
        raise MonitoringContractError(f"sensitive field is forbidden: {'.'.join((*path, str(key)))}")
      _reject_sensitive_fields(nested, (*path, str(key)))
  elif isinstance(value, (list, tuple)):
    for index, nested in enumerate(value):
      _reject_sensitive_fields(nested, (*path, str(index)))


def build_quality_drift_report(
  *,
  baseline_candidate_id: str,
  current_candidate_id: str,
  snapshots: dict[str, Any],
  maximum_absolute_drift: float,
) -> dict[str, Any]:
  maximum_absolute_drift = _finite_number(
    maximum_absolute_drift, field="maximum_absolute_drift"
  )
  if not 0 <= maximum_absolute_drift <= 1:
    raise MonitoringContractError("maximum_absolute_drift must be between zero and one")
  _reject_sensitive_fields(snapshots)
  reasons: list[dict[str, Any]] = []
  phase_reports: dict[str, Any] = {}
  for phase in PHASES:
    snapshot = snapshots.get(phase)
    if snapshot is None:
      reasons.append({"code": "phase_missing", "phase": phase})
      continue
    try:
      baseline = snapshot["baseline"]
      current = snapshot["current"]
      sample_count = int(snapshot["sample_count"])
      slices = snapshot["slices"]
      deltas = {
        key: round(
          _finite_number(current[key], field=f"{phase}.current.{key}")
          - _finite_number(value, field=f"{phase}.baseline.{key}"),
          8,
        )
        for key, value in baseline.items()
      }
    except (KeyError, TypeError, ValueError) as issue:
      raise MonitoringContractError(f"invalid aggregate snapshot for {phase}") from issue
    if sample_count <= 0:
      reasons.append({"code": "sample_missing", "phase": phase})
    for metric, delta in deltas.items():
      if abs(delta) > maximum_absolute_drift:
        reasons.append({"code": "metric_drift", "phase": phase, "metric": metric, "delta": delta})
    baseline_quality = _finite_number(
      baseline.get("quality", 0.0), field=f"{phase}.baseline.quality"
    )
    slice_deltas = {}
    for slice_name, metrics in sorted(slices.items()):
      delta = round(
        _finite_number(metrics["quality"], field=f"{phase}.slices.{slice_name}.quality")
        - baseline_quality,
        8,
      )
      slice_deltas[slice_name] = delta
      if abs(delta) > maximum_absolute_drift:
        reasons.append({
          "code": "slice_drift", "phase": phase, "slice": slice_name, "metric": "quality", "delta": delta,
        })
    phase_reports[phase] = {
      "sample_count": sample_count,
      "metric_deltas": deltas,
      "slice_quality_deltas": slice_deltas,
      "status": "blocked" if any(reason["phase"] == phase for reason in reasons) else "green",
    }
  payload = {
    "schema_version": "ai-quality-drift-v1",
    "baseline_candidate_id": baseline_candidate_id,
    "current_candidate_id": current_candidate_id,
    "generated_at": datetime.now(UTC).isoformat(),
    "maximum_absolute_drift": maximum_absolute_drift,
    "status": "blocked" if reasons else "green",
    "phases": phase_reports,
    "reasons": reasons,
    "privacy": "aggregate-only; prompts, tokens, content, PII and private identifiers forbidden",
  }
  encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
  return {**payload, "report_checksum": sha256(encoded).hexdigest()}


def register_quality_report(
  *,
  registry: ImmutableArtifactRegistry,
  candidate_id: str,
  git_sha: str,
  git_dirty: bool,
  report: dict[str, Any],
) -> CandidateManifest:
  checksum = report.get("report_checksum")
  payload = {key: value for key, value in report.items() if key != "report_checksum"}
  encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
  if checksum != sha256(encoded).hexdigest():
    raise MonitoringContractError("quality report checksum mismatch")
  report_ref = registry.register_bytes(
    json.dumps(report, sort_keys=True, separators=(",", ":")).encode() + b"\n",
    name="quality-drift-report",
    revision=str(checksum),
  )
  runtime = f"python:{platform.python_version()}"
  manifest = CandidateManifest.create(
    candidate_id=candidate_id,
    workflow="monitoring",
    evidence_level="local_in_process",
    created_at=datetime.now(UTC),
    git=GitLineage(commit_sha=git_sha, dirty=git_dirty),
    datasets=LineageGroup(
      not_applicable_reason="aggregate snapshots are not retained to prevent sensitive lineage"
    ),
    models=LineageGroup(not_applicable_reason="monitoring comparison does not execute a model"),
    prompts=LineageGroup(not_applicable_reason="monitoring comparison does not execute prompts"),
    schemas=LineageGroup(not_applicable_reason="report schema is identified by schema_version"),
    corpora=LineageGroup(not_applicable_reason="monitoring report stores aggregate deltas only"),
    qdrant_collections=LineageGroup(
      not_applicable_reason="monitoring report stores no collection identifiers"
    ),
    runtimes=(RuntimeLineage(
      name="python-quality-monitor",
      version=platform.python_version(),
      digest=sha256(runtime.encode()).hexdigest(),
    ),),
    reports=LineageGroup(items=(report_ref,)),
  )
  registry.register_manifest(manifest)
  return manifest
