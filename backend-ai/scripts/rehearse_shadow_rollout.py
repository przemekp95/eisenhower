#!/usr/bin/env python3
"""Produce deterministic, non-deploying TASK-014/TASK-023 rehearsal evidence."""

from __future__ import annotations

import argparse
from datetime import UTC, datetime, timedelta
from hashlib import sha256
import json
from pathlib import Path
import re
import subprocess
import sys
from tempfile import NamedTemporaryFile, TemporaryDirectory

import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.metrics import MetricsRegistry
from app.ops.response_canary import ResponseCanaryRouter


_EXPANSION = re.compile(r"^\$\{([A-Z0-9_]+)(?::-([^}]*))?\}$")
_SAFE_ENV_KEYS = {
  "AI_EVALUATION_FILE",
  "LOCAL_MODEL_APPROVED_EVALUATION_SHA256",
  "LOCAL_MODEL_OWNER_APPROVAL_VALID_UNTIL",
  "MEMORY_RESPONSE_ENABLED",
  "MEMORY_RETRIEVAL_ENABLED",
  "MEMORY_WRITE_ENABLED",
  "RAG_GENERATION_ENABLED",
  "RAG_RESPONSE_ENABLED",
  "RAG_RETRIEVAL_STRATEGY",
}


def _parse_bool(value: str | None, *, default: bool = False) -> bool:
  if value is None:
    return default
  normalized = value.strip().lower()
  if normalized in {"true", "1", "yes"}:
    return True
  if normalized in {"false", "0", "no", ""}:
    return False
  raise ValueError("rollout flags must use an explicit boolean value")


def _load_safe_environment(path: Path) -> dict[str, str]:
  values: dict[str, str] = {}
  for raw_line in path.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
      continue
    key, value = line.split("=", 1)
    if key in _SAFE_ENV_KEYS:
      values[key] = value.strip().strip('"').strip("'")
  return values


def _service_environment(service: dict) -> dict[str, str]:
  result: dict[str, str] = {}
  for item in service.get("environment", []):
    key, value = item.split("=", 1)
    result[key] = value
  return result


def _resolve(value: str, environment: dict[str, str]) -> str:
  match = _EXPANSION.fullmatch(value)
  if match is None:
    return value
  key, default = match.groups()
  return environment.get(key, default or "")


def _flag_contract(repository_root: Path, environment: dict[str, str]) -> tuple[dict, dict]:
  base = yaml.safe_load((repository_root / "deploy/local/compose.yaml").read_text(encoding="utf-8"))
  amd = yaml.safe_load(
    (repository_root / "deploy/local/compose.amd.yaml").read_text(encoding="utf-8")
  )
  knowledge = _service_environment(base["services"]["knowledge-service"])
  effective = {
    "retrieval_enabled": _parse_bool(_resolve(knowledge["RAG_RETRIEVAL_ENABLED"], environment)),
    "generation_enabled": _parse_bool(_resolve(knowledge["RAG_GENERATION_ENABLED"], environment)),
    "response_enabled": _parse_bool(_resolve(knowledge["RAG_RESPONSE_ENABLED"], environment)),
    "retrieval_strategy": _resolve(knowledge["RAG_RETRIEVAL_STRATEGY"], environment),
    "memory_write_enabled": _parse_bool(environment.get("MEMORY_WRITE_ENABLED")),
    "memory_retrieval_enabled": _parse_bool(environment.get("MEMORY_RETRIEVAL_ENABLED")),
    "memory_response_enabled": _parse_bool(environment.get("MEMORY_RESPONSE_ENABLED")),
  }
  command = amd["services"]["reranker"]["command"]

  def command_value(option: str) -> str:
    return str(command[command.index(option) + 1])

  served = command_value("--served-model-name")
  model, revision = served.rsplit("@", 1)
  reranker = {
    "model": model,
    "revision": revision,
    "max_model_len": int(command_value("--max-model-len")),
  }
  return effective, reranker


def _deployment_gate(environment: dict[str, str], now: datetime) -> dict[str, object]:
  evaluation_value = environment.get("AI_EVALUATION_FILE", "")
  evaluation_path = Path(evaluation_value) if evaluation_value and evaluation_value != "/dev/null" else None
  expected_digest = environment.get("LOCAL_MODEL_APPROVED_EVALUATION_SHA256", "")
  evaluation_valid = False
  if evaluation_path is not None and evaluation_path.is_file() and expected_digest:
    evaluation_valid = sha256(evaluation_path.read_bytes()).hexdigest() == expected_digest
  if evaluation_valid:
    return {"status": "eligible", "reason": "classifier_evaluation_digest_verified", "deployment_attempted": False}

  deadline_value = environment.get("LOCAL_MODEL_OWNER_APPROVAL_VALID_UNTIL", "")
  approval_expired = False
  if deadline_value:
    try:
      deadline = datetime.fromisoformat(deadline_value)
      approval_expired = deadline.tzinfo is not None and now.astimezone(UTC) >= deadline.astimezone(UTC)
    except ValueError:
      approval_expired = True
  reason = (
    "classifier_evaluation_missing_and_owner_approval_expired"
    if approval_expired else "classifier_evaluation_missing"
  )
  return {"status": "blocked", "reason": reason, "deployment_attempted": False}


def _post_expiry(now: datetime, release_sha: str) -> dict[str, object]:
  with TemporaryDirectory(prefix="eisenhower-shadow-rehearsal-") as directory:
    pointer = Path(directory) / "current.json"
    pointer.write_text(json.dumps({
      "schema_version": "ai-promotion-pointer-v1",
      "revision": 1,
      "previous_revision": 0,
      "phases": {
        "retrieval": {"mode": "shadow", "candidate_id": "retrieval-local", "canary_percent": 0},
        "generation": {"mode": "shadow", "candidate_id": "generation-local", "canary_percent": 0},
        "response": {
          "mode": "canary",
          "candidate_id": "response-local",
          "canary_percent": 15,
          "quality_report_checksum": "a" * 64,
          "approval_checksum": "b" * 64,
          "approval_valid_until": (now - timedelta(seconds=1)).isoformat(),
        },
        "mag": {"mode": "disabled", "candidate_id": None, "canary_percent": 0},
      },
    }, sort_keys=True), encoding="utf-8")
    decision = ResponseCanaryRouter(
      pointer, candidate_id="response-local", now=lambda: now
    ).evaluate("synthetic-tenant", "synthetic-user")
  registry = MetricsRegistry()
  registry.set_release_sha(release_sha)
  registry.observe_response_canary(decision.outcome)
  metric = next(
    line for line in registry.render().splitlines()
    if line.startswith('eisenhower_response_canary_decisions_total{outcome="approval_expired"}')
  )
  return {
    "decision": decision.reason,
    "generated_response_exposed": decision.allowed,
    "metric": metric,
    "subject": "synthetic_only",
  }


def _sha256_file(path: Path) -> str:
  return sha256(path.read_bytes()).hexdigest()


def _write_json(path: Path, payload: dict) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  serialized = json.dumps(payload, indent=2, sort_keys=True) + "\n"
  with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
    handle.write(serialized)
    temporary = Path(handle.name)
  temporary.replace(path)


def main() -> int:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--repository-root", type=Path, required=True)
  parser.add_argument("--deployment-env", type=Path, required=True)
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument("--now", type=datetime.fromisoformat, required=True)
  parser.add_argument("--runtime-release-sha")
  args = parser.parse_args()

  repository_root = args.repository_root.resolve()
  now = args.now
  if now.tzinfo is None:
    raise SystemExit("--now must include a timezone")
  release_sha = subprocess.run(
    ["git", "rev-parse", "HEAD"], cwd=repository_root, check=True,
    capture_output=True, text=True,
  ).stdout.strip()
  environment = _load_safe_environment(args.deployment_env)
  effective, reranker = _flag_contract(repository_root, environment)
  expected = {
    "retrieval_enabled": True,
    "generation_enabled": False,
    "response_enabled": False,
    "retrieval_strategy": "hybrid-bge-v1",
    "memory_write_enabled": False,
    "memory_retrieval_enabled": False,
    "memory_response_enabled": False,
  }
  if effective != expected:
    raise SystemExit("effective local rehearsal is not retrieval-only and fail-closed")

  disabled = dict(effective)
  disabled.update({
    "retrieval_enabled": False,
    "generation_enabled": False,
    "response_enabled": False,
    "memory_write_enabled": False,
    "memory_retrieval_enabled": False,
    "memory_response_enabled": False,
  })
  restored = dict(effective)
  inputs = (
    repository_root / "deploy/local/compose.yaml",
    repository_root / "deploy/local/compose.amd.yaml",
    repository_root / "backend-ai/app/ops/response_canary.py",
    repository_root / "backend-ai/app/metrics.py",
  )
  report = {
    "schema_version": "shadow-rollout-local-rehearsal-v1",
    "observed_at": now.astimezone(UTC).isoformat(),
    "source_sha": release_sha,
    "runtime_release_sha": args.runtime_release_sha,
    "effective_retrieval_only": effective,
    "pinned_reranker": reranker,
    "disable_restore": {
      "initial": effective,
      "disabled": disabled,
      "restored": restored,
      "restored_matches_initial": restored == effective,
      "runtime_mutated": False,
    },
    "post_expiry": _post_expiry(now, release_sha),
    "deployment_gate": _deployment_gate(environment, now),
    "input_sha256": {
      str(path.relative_to(repository_root)): _sha256_file(path) for path in inputs
    },
    "evidence_boundary": {
      "deterministic_local_rehearsal": True,
      "runtime_mutated": False,
      "real_user_traffic": False,
      "real_cohort": False,
      "publication": False,
      "task_014_closed": False,
      "task_023_closed": False,
    },
  }
  _write_json(args.output, report)
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
