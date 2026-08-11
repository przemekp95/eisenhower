from __future__ import annotations

from pathlib import Path
import re

from app.ci_impact.models import JobConfig


JOB_LINE = re.compile(r"^  (?P<job>[a-z0-9][a-z0-9-]+):\s*$", re.MULTILINE)
QUOTED_VALUE = re.compile(r"['\"](?P<value>[a-z0-9][a-z0-9-]+)['\"]")


def validate_repository_job_universe(root: Path, config: JobConfig) -> tuple[str, ...]:
  """Cross-check every current canonical CI context source before model use."""
  reasons: list[str] = []
  all_contexts = set(config.all_jobs) - {"resolve-run-mode"}
  required_contexts = set(config.required_context_jobs) - {"resolve-run-mode"}
  try:
    workflow_text = (root / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    workflow_jobs = set(JOB_LINE.findall(workflow_text.split("\njobs:\n", 1)[1]))
    expected_workflow = {"resolve-run-mode", *all_contexts}
    if workflow_jobs != expected_workflow:
      reasons.append("workflow_job_universe_mismatch")
  except (IndexError, OSError):
    reasons.append("workflow_job_universe_mismatch")
  try:
    bridge_text = (root / ".github/scripts/bridge-sync-pr-statuses.mjs").read_text(encoding="utf-8")
    bridge_block = bridge_text.split("CI: [", 1)[1].split("],", 1)[0]
    bridge_jobs = {match.group("value") for match in QUOTED_VALUE.finditer(bridge_block)}
    bridge_jobs.discard("resolve-run-mode")
    if bridge_jobs != required_contexts:
      reasons.append("bridge_job_universe_mismatch")
  except (IndexError, OSError):
    reasons.append("bridge_job_universe_mismatch")
  try:
    branch_text = (root / ".github/workflows/branch-policy.yml").read_text(encoding="utf-8")
    branch_jobs = set(JOB_LINE.findall(branch_text.split("\njobs:\n", 1)[1]))
    bridge_branch = bridge_text.split("'Branch Policy': [", 1)[1].split("],", 1)[0]
    bridge_branch_jobs = {match.group("value") for match in QUOTED_VALUE.finditer(bridge_branch)}
    if branch_jobs != {"branch-policy"} or bridge_branch_jobs != {"branch-policy"}:
      reasons.append("branch_policy_context_mismatch")
  except (IndexError, OSError, UnboundLocalError):
    reasons.append("branch_policy_context_mismatch")
  try:
    sync_text = (root / ".github/workflows/sync-master-into-dev.yml").read_text(encoding="utf-8")
    sync_block = sync_text.split("required_jobs=(", 1)[1].split(")", 1)[0]
    sync_jobs = {
      line.strip() for line in sync_block.splitlines()
      if line.strip() and re.fullmatch(r"[a-z0-9][a-z0-9-]+", line.strip())
    }
    sync_jobs.discard("resolve-run-mode")
    if sync_jobs != required_contexts:
      reasons.append("sync_job_universe_mismatch")
  except (IndexError, OSError):
    reasons.append("sync_job_universe_mismatch")
  return tuple(reasons)
