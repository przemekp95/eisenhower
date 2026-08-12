#!/usr/bin/env python3
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import re
import sys
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.ci_impact.history import normalize_github_pr, write_dataset
from app.ci_impact.models import JobConfig
from app.ci_impact.process import BoundedProcessError, run_bounded


def _write_once(path: Path, payload: bytes) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  try:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
  except FileExistsError as issue:
    if path.read_bytes() != payload:
      raise ValueError("immutable CI impact receipt conflict") from issue
    return
  try:
    remaining = memoryview(payload)
    while remaining:
      written = os.write(descriptor, remaining)
      if written <= 0:
        raise OSError("immutable receipt write made no progress")
      remaining = remaining[written:]
    os.fsync(descriptor)
  finally:
    os.close(descriptor)


@dataclass
class CollectionBudget:
  remaining_bytes: int = 128 * 1024 * 1024
  remaining_requests: int = 1000

  def consume(self, payload: bytes) -> None:
    self.remaining_bytes -= len(payload)
    self.remaining_requests -= 1
    if self.remaining_bytes < 0 or self.remaining_requests < 0:
      raise ValueError("GitHub history cumulative collection budget exceeded")


def _gh(endpoint: str, *, budget: CollectionBudget, paginated: bool = False) -> Any:
  command = ["gh", "api", endpoint]
  if paginated:
    command.extend(("--paginate", "--slurp"))
  payload = run_bounded(
    command,
    cwd=PROJECT_ROOT.parent,
    timeout_seconds=120,
    maximum_stdout_bytes=64 * 1024 * 1024,
  )
  budget.consume(payload)
  return json.loads(payload)


def _flatten_pages(payload: Any) -> list[dict[str, Any]]:
  if isinstance(payload, list) and payload and all(isinstance(page, list) for page in payload):
    return [item for page in payload for item in page]
  if isinstance(payload, list):
    return payload
  raise ValueError("GitHub pagination returned an unexpected payload")


def collect(
  *, repo: str, base: str, minimum_pr: int, maximum_pr: int, config: JobConfig
) -> tuple:
  if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
    raise ValueError("GitHub repository identity is invalid")
  if not re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", base) or ".." in base.split("/"):
    raise ValueError("GitHub base branch is invalid")
  if maximum_pr - minimum_pr + 1 > 250:
    raise ValueError("pull request range exceeds the bounded collection window")
  budget = CollectionBudget()
  pulls = _flatten_pages(_gh(
    f"repos/{repo}/pulls?state=closed&base={base}&per_page=100", budget=budget, paginated=True
  ))
  records = []
  total_files = 0
  total_checks = 0
  for pull in sorted(pulls, key=lambda item: item["number"]):
    number = int(pull["number"])
    if not minimum_pr <= number <= maximum_pr or not pull.get("merged_at"):
      continue
    if (
      pull.get("base", {}).get("ref") != base
      or (pull.get("base", {}).get("repo") or {}).get("full_name") != repo
    ):
      raise ValueError("pull request repository/base identity mismatch")
    head_sha = str(pull["head"]["sha"])
    files = _flatten_pages(_gh(
      f"repos/{repo}/pulls/{number}/files?per_page=100", budget=budget, paginated=True
    ))
    checks_pages = _gh(
      f"repos/{repo}/commits/{head_sha}/check-runs?per_page=100", budget=budget, paginated=True
    )
    suites_pages = _gh(
      f"repos/{repo}/commits/{head_sha}/check-suites?per_page=100", budget=budget, paginated=True
    )
    trusted_suite_ids = {
      suite.get("id") for page in suites_pages for suite in page.get("check_suites", [])
      if suite.get("head_sha") == head_sha
      and (suite.get("app") or {}).get("slug") == "github-actions"
    }
    checks = [
      check for page in checks_pages for check in page.get("check_runs", [])
      if (check.get("check_suite") or {}).get("id") in trusted_suite_ids
      and (check.get("app") or {}).get("slug") == "github-actions"
    ]
    workflow = _gh(
      f"repos/{repo}/contents/.github/workflows/ci.yml?ref={head_sha}", budget=budget
    )
    total_files += len(files)
    total_checks += len(checks)
    if total_files > 50_000 or total_checks > 25_000:
      raise ValueError("GitHub history cumulative record budget exceeded")
    records.append(normalize_github_pr(
      pull_request={
        "number": number,
        "merged_at": pull["merged_at"],
        "base_sha": pull["base"]["sha"],
        "head_sha": head_sha,
        "workflow_sha": workflow["sha"],
      },
      files=files,
      job_results=[{
        "name": check["name"],
        "conclusion": check.get("conclusion"),
        "run_id": check.get("id"),
        "attempt": check.get("run_attempt"),
      } for check in checks],
      all_jobs=config.all_jobs,
    ))
  return tuple(records)


def main() -> int:
  parser = argparse.ArgumentParser(description="Collect factual PR/files/job observations for manual CI-impact labeling.")
  parser.add_argument("--repo", required=True)
  parser.add_argument("--base", default="dev")
  parser.add_argument("--minimum-pr", type=int, required=True)
  parser.add_argument("--maximum-pr", type=int, required=True)
  parser.add_argument("--jobs-config", type=Path, required=True)
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument("--receipt", type=Path, required=True)
  args = parser.parse_args()
  if args.minimum_pr < 1 or args.maximum_pr < args.minimum_pr:
    parser.error("invalid pull request range")
  try:
    config = JobConfig.model_validate_json(args.jobs_config.read_text(encoding="utf-8"))
    records = collect(
      repo=args.repo,
      base=args.base,
      minimum_pr=args.minimum_pr,
      maximum_pr=args.maximum_pr,
      config=config,
    )
    receipt = write_dataset(args.output, records)
    receipt_payload = {
      **receipt.model_dump(mode="json"),
      "source": {"provider": "github", "repo": args.repo, "base": args.base},
      "pull_request_range": [args.minimum_pr, args.maximum_pr],
      "collected_at": datetime.now(UTC).isoformat(),
      "label_policy": "observed job conclusions remain unknown until conservative manual review",
      "check_evidence_policy": "GitHub Actions app check-suite head_sha must equal the PR head SHA",
      "job_config_sha256": config.checksum(),
    }
    _write_once(
      args.receipt,
      (json.dumps(receipt_payload, indent=2, sort_keys=True) + "\n").encode(),
    )
    print(json.dumps({"records": receipt.record_count, "sha256": receipt.sha256, "unknown": receipt.unknown}))
    return 0
  except (BoundedProcessError, OSError, ValueError) as issue:
    print(f"ci-impact-history-blocked: {issue}", file=sys.stderr)
    return 2


if __name__ == "__main__":
  raise SystemExit(main())
