from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
import json
import os
from pathlib import Path
from typing import Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError


MAXIMUM_AUTHORIZED_DEADLINE = datetime(2026, 8, 15, 21, 59, 59, tzinfo=UTC)
EXPECTED_STRATEGY_IDS = {
  "hybrid_reranker": "hybrid-bge-v1",
  "hybrid_no_reranker": "hybrid-rrf-v1",
}
AUTOMATED_APPROVERS = {"automation", "bot", "ci", "self", "system", "unknown"}


class HoldoutAcceptanceBlocked(ValueError):
  """Raised when owner acceptance cannot authorize the one bounded holdout run."""


@dataclass(frozen=True)
class HoldoutAcceptanceInputs:
  candidate: Path
  thresholds: Path
  corpus_manifest: Path
  strategy_reports: dict[str, Path]
  source_git_sha: str


class OwnerHoldoutAcceptance(BaseModel):
  model_config = ConfigDict(extra="forbid")

  schema_version: Literal["retrieval-holdout-owner-acceptance-v1"]
  scope: Literal["task-048-exact-strategy-holdout-comparison-only"]
  approval_source: Literal["owner_out_of_band"]
  authentication_level: Literal["repository_record_only"]
  approved_by: str = Field(min_length=1, max_length=128)
  approved_at: datetime
  valid_until: datetime
  decision: Literal["accept_missing_independent_review_for_one_holdout_run"]
  independent_human_review: Literal[False]
  case_decisions_created: Literal[False]
  single_use: Literal[True]
  tuning_authorized: Literal[False]
  promotion_authorized: Literal[False]
  deployment_authorized: Literal[False]
  source_baseline_git_sha: str = Field(pattern=r"^[a-f0-9]{40}$")
  candidate_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
  thresholds_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
  corpus_manifest_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
  corpus_snapshot_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
  strategy_report_sha256: dict[str, str]
  strategy_ids: dict[str, str]


def _digest(path: Path) -> str:
  try:
    return sha256(path.read_bytes()).hexdigest()
  except OSError as issue:
    raise HoldoutAcceptanceBlocked(f"bound input is unavailable: {path}") from issue


def _utc(value: datetime, field: str) -> datetime:
  if value.tzinfo is None or value.utcoffset() is None:
    raise HoldoutAcceptanceBlocked(f"{field} must include a timezone")
  return value.astimezone(UTC)


def validate_owner_acceptance(
  receipt_path: Path,
  *,
  inputs: HoldoutAcceptanceInputs,
  now: datetime,
) -> OwnerHoldoutAcceptance:
  try:
    raw = receipt_path.read_bytes()
    payload = json.loads(raw)
    acceptance = OwnerHoldoutAcceptance.model_validate(payload)
  except (OSError, json.JSONDecodeError, ValidationError) as issue:
    raise HoldoutAcceptanceBlocked(f"owner acceptance receipt is invalid: {issue}") from issue

  approved_at = _utc(acceptance.approved_at, "approved_at")
  valid_until = _utc(acceptance.valid_until, "valid_until")
  checked_at = _utc(now, "current time")
  if approved_at > checked_at + timedelta(minutes=5):
    raise HoldoutAcceptanceBlocked("owner acceptance approved_at is in the future")
  if valid_until > MAXIMUM_AUTHORIZED_DEADLINE:
    raise HoldoutAcceptanceBlocked("owner acceptance exceeds the maximum authorized deadline")
  if checked_at >= valid_until:
    raise HoldoutAcceptanceBlocked("owner acceptance has expired")
  if acceptance.approved_by.strip().casefold() in AUTOMATED_APPROVERS:
    raise HoldoutAcceptanceBlocked("owner acceptance requires a named human owner")
  if acceptance.source_baseline_git_sha != inputs.source_git_sha:
    raise HoldoutAcceptanceBlocked("owner acceptance source git SHA mismatch")

  expected_digests = {
    "candidate": (acceptance.candidate_sha256, _digest(inputs.candidate)),
    "thresholds": (acceptance.thresholds_sha256, _digest(inputs.thresholds)),
    "corpus manifest": (
      acceptance.corpus_manifest_sha256,
      _digest(inputs.corpus_manifest),
    ),
  }
  try:
    manifest = json.loads(inputs.corpus_manifest.read_text(encoding="utf-8"))
    snapshot_digest = manifest["initial_snapshot"]["sha256"]
  except (OSError, json.JSONDecodeError, KeyError, TypeError) as issue:
    raise HoldoutAcceptanceBlocked("corpus manifest snapshot digest is unavailable") from issue
  expected_digests["corpus snapshot"] = (
    acceptance.corpus_snapshot_sha256,
    snapshot_digest,
  )
  drifted = [name for name, (expected, actual) in expected_digests.items() if expected != actual]
  if drifted:
    raise HoldoutAcceptanceBlocked(f"bound input digest mismatch: {', '.join(drifted)}")

  if set(inputs.strategy_reports) != set(EXPECTED_STRATEGY_IDS):
    raise HoldoutAcceptanceBlocked("bound strategy report set is invalid")
  if acceptance.strategy_ids != EXPECTED_STRATEGY_IDS:
    raise HoldoutAcceptanceBlocked("owner acceptance strategy ids do not match the frozen pair")
  actual_strategy_digests = {
    name: _digest(path) for name, path in inputs.strategy_reports.items()
  }
  if acceptance.strategy_report_sha256 != actual_strategy_digests:
    raise HoldoutAcceptanceBlocked("strategy report digest mismatch")
  return acceptance


def _quality_gate(result: object, thresholds: dict) -> dict:
  if not isinstance(result, dict) or not isinstance(result.get("metrics"), dict):
    raise HoldoutAcceptanceBlocked("evaluator omitted retrieval metrics")
  metrics = result["metrics"]
  checks: dict[str, bool] = {}

  def check(prefix: str, actual: dict, policy: dict) -> None:
    for name, limit in policy.items():
      if name.endswith("_min"):
        metric = name.removesuffix("_min")
        checks[f"{prefix}.{name}"] = actual.get(metric) is not None and actual[metric] >= limit
      elif name.endswith("_max"):
        metric = name.removesuffix("_max")
        checks[f"{prefix}.{name}"] = actual.get(metric) is not None and actual[metric] <= limit

  check("global", metrics, thresholds["global"])
  check("required_slices.language_pl", metrics.get("by_language", {}).get("pl", {}),
        thresholds["required_slices"]["language_pl"])
  check("required_slices.language_en", metrics.get("by_language", {}).get("en", {}),
        thresholds["required_slices"]["language_en"])
  check("required_slices.split_holdout", metrics.get("by_split", {}).get("holdout", {}),
        thresholds["required_slices"]["split_holdout"])
  return {"passed": bool(checks) and all(checks.values()), "checks": checks}


def _validate_comparison(report: object, thresholds_path: Path) -> dict:
  if not isinstance(report, dict):
    raise HoldoutAcceptanceBlocked("evaluator violated the frozen holdout comparison contract")
  if (
    report.get("evaluated_split") != "holdout"
    or report.get("tuning_performed") is not False
    or set(report.get("strategies", {})) != set(EXPECTED_STRATEGY_IDS)
  ):
    raise HoldoutAcceptanceBlocked("evaluator violated the frozen holdout comparison contract")
  try:
    thresholds = json.loads(thresholds_path.read_text(encoding="utf-8"))
    if thresholds["k"] != 5:
      raise HoldoutAcceptanceBlocked("frozen threshold k must equal five")
  except (OSError, json.JSONDecodeError, KeyError, TypeError) as issue:
    raise HoldoutAcceptanceBlocked("frozen thresholds are invalid") from issue
  gates = {
    name: _quality_gate(result, thresholds)
    for name, result in report["strategies"].items()
  }
  report["quality_gate"] = {
    "thresholds_sha256": _digest(thresholds_path),
    "strategies": gates,
    "selected_strategy": (
      "hybrid_no_reranker" if gates["hybrid_no_reranker"]["passed"]
      else "hybrid_reranker"
    ),
    "simplification_accepted": gates["hybrid_no_reranker"]["passed"],
    "rollback_strategy": "hybrid-bge-v1",
  }
  return report


def _write_once(path: Path, payload: dict) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  encoded = (json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
  try:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
  except FileExistsError as issue:
    raise HoldoutAcceptanceBlocked("holdout report already exists; refusing replay") from issue
  try:
    with os.fdopen(descriptor, "wb") as target:
      target.write(encoded)
      target.flush()
      os.fsync(target.fileno())
  except BaseException:
    path.unlink(missing_ok=True)
    raise


def run_owner_accepted_holdout(
  receipt_path: Path,
  *,
  inputs: HoldoutAcceptanceInputs,
  output: Path,
  evaluator: Callable[[], dict],
  now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> dict:
  if output.exists():
    raise HoldoutAcceptanceBlocked("holdout report already exists; refusing replay")
  started_at = now()
  acceptance = validate_owner_acceptance(receipt_path, inputs=inputs, now=started_at)
  receipt_digest = _digest(receipt_path)
  use_marker = receipt_path.with_name(f"{receipt_path.name}.{receipt_digest}.used")
  _write_once(use_marker, {
    "schema_version": "retrieval-holdout-owner-acceptance-use-v1",
    "approval_receipt_sha256": receipt_digest,
    "source_git_sha": inputs.source_git_sha,
    "holdout_started_at": started_at.astimezone(UTC).isoformat(),
  })
  comparison = _validate_comparison(evaluator(), inputs.thresholds)
  completed_at = now()
  validate_owner_acceptance(receipt_path, inputs=inputs, now=completed_at)
  report = {
    **comparison,
    "governance": {
      "approval_mode": "time_bounded_owner_acceptance",
      "approval_receipt_sha256": receipt_digest,
      "approval_use_marker": use_marker.name,
      "approval_valid_until": acceptance.valid_until.isoformat(),
      "approval_authentication": acceptance.authentication_level,
      "independent_human_review_satisfied": False,
      "case_decisions_created": False,
      "governance_issues": ["owner_accepted_missing_independent_relevance_review"],
      "single_use": True,
      "tuning_authorized": False,
      "promotion_authorized": False,
      "deployment_authorized": False,
    },
    "holdout_started_at": started_at.astimezone(UTC).isoformat(),
    "holdout_completed_at": completed_at.astimezone(UTC).isoformat(),
  }
  _write_once(output, report)
  return report
