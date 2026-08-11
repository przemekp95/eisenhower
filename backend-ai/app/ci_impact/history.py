from __future__ import annotations

from datetime import datetime
from hashlib import sha256
import json
from pathlib import Path
from typing import Any

from app.ci_impact.models import (
  ChangeFile,
  ChangeSet,
  DatasetReceipt,
  HistoryRecord,
  JobLabel,
  JobObservation,
)


STATUS_MAP = {
  "added": "added",
  "modified": "modified",
  "changed": "modified",
  "removed": "deleted",
  "deleted": "deleted",
  "renamed": "renamed",
  "copied": "copied",
}
CONCLUSIONS = {
  "success", "failure", "cancelled", "skipped", "timed_out", "action_required", "neutral",
}


def normalize_github_pr(
  *,
  pull_request: dict[str, Any],
  files: list[dict[str, Any]],
  job_results: list[dict[str, Any]],
  all_jobs: tuple[str, ...],
) -> HistoryRecord:
  """Normalize observations only; CI conclusions never become labels automatically."""
  if len(files) > 5000 or len(job_results) > 1000:
    raise ValueError("GitHub history input exceeds bounded record limits")
  changes = tuple(_normalize_file(item) for item in files)
  observations = tuple(
    JobObservation(
      name=str(item["name"]),
      conclusion=str(item.get("conclusion")) if item.get("conclusion") in CONCLUSIONS else "unknown",
      run_id=item.get("run_id"),
      attempt=item.get("attempt"),
    )
    for item in job_results if item.get("name") in set(all_jobs)
  )
  labels = {
    job: JobLabel(value="unknown", provenance="manual_review_required") for job in all_jobs
  }
  return HistoryRecord(
    pull_request_number=int(pull_request["number"]),
    merged_at=datetime.fromisoformat(str(pull_request["merged_at"]).replace("Z", "+00:00")),
    changes=ChangeSet(
      base_sha=str(pull_request["base_sha"]),
      head_sha=str(pull_request["head_sha"]),
      files=changes,
    ),
    job_results=observations,
    labels=labels,
    workflow_sha=pull_request.get("workflow_sha"),
  )


def _normalize_file(item: dict[str, Any]) -> ChangeFile:
  status = STATUS_MAP.get(str(item.get("status", "")))
  if status is None:
    raise ValueError("GitHub file status is unsupported")
  additions = item.get("additions", 0)
  deletions = item.get("deletions", 0)
  binary = (
    additions is None
    or deletions is None
    or item.get("binary") is True
    or "patch" not in item
  )
  return ChangeFile(
    path=str(item["filename"]),
    previous_path=item.get("previous_filename"),
    status=status,
    additions=0 if additions is None else int(additions),
    deletions=0 if deletions is None else int(deletions),
    binary=binary,
  )


def write_dataset(path: Path, records: tuple[HistoryRecord, ...]) -> DatasetReceipt:
  ordered = tuple(sorted(records, key=lambda item: (item.merged_at, item.pull_request_number)))
  if len({item.pull_request_number for item in ordered}) != len(ordered):
    raise ValueError("dataset contains duplicate pull request records")
  payload = "".join(
    json.dumps(item.model_dump(mode="json"), ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    for item in ordered
  ).encode()
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_bytes(payload)
  counts = {"required": 0, "safe_to_skip": 0, "unknown": 0}
  for record in ordered:
    for label in record.labels.values():
      counts[label.value] += 1
  return DatasetReceipt(
    record_count=len(ordered),
    sha256=sha256(payload).hexdigest(),
    labeled_required=counts["required"],
    labeled_safe_to_skip=counts["safe_to_skip"],
    unknown=counts["unknown"],
  )


def read_dataset(path: Path) -> tuple[HistoryRecord, ...]:
  records: list[HistoryRecord] = []
  for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
    try:
      records.append(HistoryRecord.model_validate_json(line))
    except ValueError as issue:
      raise ValueError(f"invalid CI history record on line {line_number}") from issue
  return tuple(records)
