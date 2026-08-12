from __future__ import annotations

from hashlib import sha256
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Mapping

from app.ci_impact.models import DeterministicTargetAdapter, JobConfig
from app.ci_impact.process import run_bounded


def resolve_actions_context(
  environment: Mapping[str, str],
  *,
  requested_event_name: str | None,
  requested_ref_name: str | None,
  requested_base_ref_name: str | None,
) -> tuple[str, str, str, bool]:
  """Bind selective evaluation to immutable Actions context, or mark local input untrusted."""
  actions_trusted = environment.get("GITHUB_ACTIONS") == "true"
  if not actions_trusted:
    if not requested_event_name or not requested_ref_name or requested_base_ref_name is None:
      raise ValueError("explicit local event/ref/base-ref context is missing")
    return requested_event_name, requested_ref_name, requested_base_ref_name, False

  event_name = environment.get("GITHUB_EVENT_NAME")
  ref_name = environment.get("GITHUB_REF_NAME")
  base_ref_name = environment.get("GITHUB_BASE_REF", "")
  if not event_name or not ref_name:
    raise ValueError("trusted GitHub Actions event/ref context is missing")
  requested = (requested_event_name, requested_ref_name, requested_base_ref_name)
  expected = (event_name, ref_name, base_ref_name)
  if any(value is not None and value != expected[index] for index, value in enumerate(requested)):
    raise ValueError("caller context differs from trusted GitHub Actions context")
  return event_name, ref_name, base_ref_name, True


def _canonical_resolver_environment(environment: Mapping[str, str]) -> dict[str, str]:
  """Keep only process-discovery/locale state; never inherit Actions command files."""
  result = {"PATH": environment.get("PATH", os.defpath)}
  for name in ("LANG", "LC_ALL", "LC_CTYPE"):
    if value := environment.get(name):
      result[name] = value
  return result


def resolve_authoritative_plan(
  repo_root: Path,
  *,
  base_sha: str,
  head_sha: str,
  event_name: str,
  ref_name: str,
  base_ref_name: str,
) -> dict:
  script = repo_root / ".github/scripts/ci-impact-plan.mjs"
  if not script.is_file():
    raise ValueError("canonical deterministic planner is missing")
  with TemporaryDirectory(prefix="ci-impact-plan-") as temporary:
    output = Path(temporary) / "plan.json"
    stdout = run_bounded(
      (
        "node", str(script), "--base", base_sha, "--head", head_sha,
        "--event", event_name, "--ref", ref_name, "--base-ref", base_ref_name,
        "--output", str(output),
      ),
      cwd=repo_root,
      timeout_seconds=30,
      maximum_stdout_bytes=2 * 1024 * 1024,
      env=_canonical_resolver_environment(os.environ),
    )
    stdout_plan = json.loads(stdout)
    file_plan = json.loads(output.read_text(encoding="utf-8"))
  if stdout_plan != file_plan or not isinstance(stdout_plan, dict):
    raise ValueError("canonical deterministic planner output mismatch")
  return stdout_plan


def verify_deterministic_plan(
  payload: object,
  *,
  expected_base_sha: str,
  expected_head_sha: str,
  expected_changes: tuple[dict[str, str], ...],
  expected_event_name: str,
  expected_ref_name: str,
  expected_base_ref_name: str,
  authoritative_plan: dict,
  adapter: DeterministicTargetAdapter,
  config: JobConfig,
) -> tuple[tuple[str, ...], bool]:
  if not isinstance(payload, dict):
    raise ValueError("deterministic plan must be an object")
  required = {
    "version", "inputDigest", "eventName", "refName", "baseRefName", "mergeBase", "headSha",
    "fullCi", "targets", "reasons", "changes",
  }
  if set(payload) != required:
    raise ValueError("deterministic plan fields mismatch")
  scalar_fields = ("inputDigest", "eventName", "refName", "baseRefName", "mergeBase", "headSha")
  if payload.get("version") != adapter.plan_version or any(
    not isinstance(payload.get(field), str) for field in scalar_fields
  ):
    raise ValueError("deterministic plan scalar contract mismatch")
  if payload["mergeBase"] != expected_base_sha or payload["headSha"] != expected_head_sha:
    raise ValueError("deterministic plan revision mismatch")
  if (
    payload["eventName"] != expected_event_name
    or payload["refName"] != expected_ref_name
    or payload["baseRefName"] != expected_base_ref_name
  ):
    raise ValueError("deterministic plan event or ref mismatch")
  if not isinstance(payload.get("fullCi"), bool) or not isinstance(payload.get("reasons"), dict):
    raise ValueError("deterministic plan decision contract mismatch")
  targets = payload.get("targets")
  changes = payload.get("changes")
  if (
    not isinstance(targets, list)
    or any(not isinstance(target, str) for target in targets)
    or len(targets) != len(set(targets))
    or changes != list(expected_changes)
  ):
    raise ValueError("deterministic plan targets or changes mismatch")
  digest_input = {
    "version": adapter.plan_version,
    "eventName": payload["eventName"],
    "refName": payload["refName"],
    "baseRefName": payload["baseRefName"],
    "mergeBase": payload["mergeBase"],
    "headSha": payload["headSha"],
    "changes": changes,
    "error": None,
  }
  canonical = json.dumps(digest_input, ensure_ascii=False, separators=(",", ":"))
  expected_digest = "sha256:" + sha256(canonical.encode()).hexdigest()
  if payload["inputDigest"] != expected_digest:
    raise ValueError("deterministic plan digest mismatch")
  if payload != authoritative_plan:
    raise ValueError("deterministic decision differs from canonical planner")
  return adapter.jobs_for(tuple(targets), config), payload["fullCi"]
