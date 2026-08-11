#!/usr/bin/env python3
from __future__ import annotations

import argparse
from datetime import UTC, datetime
import json
from pathlib import Path
import subprocess
import sys
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.ci_impact.history import normalize_github_pr, write_dataset
from app.ci_impact.models import JobConfig


def _gh(endpoint: str, *, paginated: bool = False) -> Any:
  command = ["gh", "api", endpoint]
  if paginated:
    command.extend(("--paginate", "--slurp"))
  completed = subprocess.run(command, check=True, capture_output=True, text=True, timeout=120)
  return json.loads(completed.stdout)


def _flatten_pages(payload: Any) -> list[dict[str, Any]]:
  if isinstance(payload, list) and payload and all(isinstance(page, list) for page in payload):
    return [item for page in payload for item in page]
  if isinstance(payload, list):
    return payload
  raise ValueError("GitHub pagination returned an unexpected payload")


def collect(
  *, repo: str, base: str, minimum_pr: int, maximum_pr: int, config: JobConfig
) -> tuple:
  pulls = _flatten_pages(_gh(f"repos/{repo}/pulls?state=closed&base={base}&per_page=100", paginated=True))
  records = []
  for pull in sorted(pulls, key=lambda item: item["number"]):
    number = int(pull["number"])
    if not minimum_pr <= number <= maximum_pr or not pull.get("merged_at"):
      continue
    files = _flatten_pages(_gh(f"repos/{repo}/pulls/{number}/files?per_page=100", paginated=True))
    checks_pages = _gh(
      f"repos/{repo}/commits/{pull['head']['sha']}/check-runs?per_page=100", paginated=True
    )
    checks = [check for page in checks_pages for check in page.get("check_runs", [])]
    workflow = _gh(f"repos/{repo}/contents/.github/workflows/ci.yml?ref={pull['head']['sha']}")
    records.append(normalize_github_pr(
      pull_request={
        "number": number,
        "merged_at": pull["merged_at"],
        "base_sha": pull["base"]["sha"],
        "head_sha": pull["head"]["sha"],
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
      "job_config_sha256": config.checksum(),
    }
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt_payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"records": receipt.record_count, "sha256": receipt.sha256, "unknown": receipt.unknown}))
    return 0
  except (OSError, subprocess.SubprocessError, ValueError) as issue:
    print(f"ci-impact-history-blocked: {issue}", file=sys.stderr)
    return 2


if __name__ == "__main__":
  raise SystemExit(main())
