#!/usr/bin/env python3
from __future__ import annotations

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
from statistics import median
import tempfile
from typing import Any


class BenchmarkSetRejected(RuntimeError):
  """The supplied reports cannot support a comparable repetition summary."""


def _percentile(values: list[float], fraction: float) -> float:
  ordered = sorted(values)
  position = (len(ordered) - 1) * fraction
  lower = int(position)
  upper = min(lower + 1, len(ordered) - 1)
  weight = position - lower
  return ordered[lower] + ((ordered[upper] - ordered[lower]) * weight)


def _metrics(values: list[int | float]) -> dict[str, int | float]:
  floating = [float(value) for value in values]
  integral = all(isinstance(value, int) for value in values)

  def normalized(value: float) -> int | float:
    return int(value) if integral and value.is_integer() else round(value, 6)

  return {
    "minimum": normalized(min(floating)),
    "median": normalized(float(median(floating))),
    "p95": normalized(_percentile(floating, 0.95)),
    "maximum": normalized(max(floating)),
  }


def _load(path: Path) -> tuple[dict[str, Any], str]:
  payload = path.read_bytes()
  try:
    report = json.loads(payload)
  except json.JSONDecodeError as error:
    raise BenchmarkSetRejected(f"malformed benchmark report: {path}") from error
  if not isinstance(report, dict):
    raise BenchmarkSetRejected(f"benchmark report is not an object: {path}")
  return report, sha256(payload).hexdigest()


def _identity(report: dict[str, Any]) -> dict[str, Any]:
  workload = report.get("workload") or {}
  return {
    "schema_version": report.get("schema_version"),
    "role": report.get("role"),
    "source_git_sha": report.get("source_git_sha"),
    "image": report.get("image"),
    "limits": report.get("limits"),
    "workload_command": workload.get("command"),
    "docling_manifest_sha256": workload.get("docling_manifest_sha256"),
  }


def summarize(paths: list[Path]) -> dict[str, Any]:
  if len(paths) < 3:
    raise BenchmarkSetRejected("at least three repetitions are required")
  loaded = [_load(path) for path in paths]
  reports = [item[0] for item in loaded]
  expected = _identity(reports[0])
  if expected["schema_version"] != "runtime-role-container-benchmark-v1":
    raise BenchmarkSetRejected("unsupported benchmark report schema")
  if expected["role"] != "ingest-document-extraction":
    raise BenchmarkSetRejected("report is not an ingest benchmark")

  runs = []
  for path, (report, digest) in zip(paths, loaded, strict=True):
    if _identity(report) != expected:
      raise BenchmarkSetRejected("benchmark reports have different identities, workloads or limits")
    if report.get("source_git_dirty") is not False:
      raise BenchmarkSetRejected("benchmark source must be clean")
    result = report.get("result") or {}
    if result.get("exit_code") != 0 or result.get("oom_killed") or result.get("timed_out"):
      raise BenchmarkSetRejected("all repetitions must complete without OOM or timeout")
    cases = (report.get("workload_report") or {}).get("cases")
    if not isinstance(cases, list) or len(cases) != 11:
      raise BenchmarkSetRejected("every repetition must contain all 11 extraction cases")
    if not all(case.get("required_phrases_present") is True for case in cases):
      raise BenchmarkSetRejected("a required extraction phrase is missing")
    cgroup = result.get("cgroup") or {}
    runs.append({
      "report": path.name,
      "report_sha256": digest,
      "recorded_at": report.get("recorded_at"),
      "wall_seconds": result["wall_seconds"],
      "cpu_seconds": cgroup["cpu_seconds"],
      "cgroup_memory_peak_bytes": cgroup["cgroup_memory_peak_bytes"],
      "peak_pids": cgroup["peak_pids"],
      "memory_max_events": cgroup["memory_max_events"],
      "memory_oom_events": cgroup["memory_oom_events"],
      "memory_oom_kill_events": cgroup["memory_oom_kill_events"],
    })

  return {
    "schema_version": "runtime-role-repetition-summary-v1",
    "evidence_level": "local-isolated-container-repetitions",
    "deployment_proven": False,
    "production_proven": False,
    "source_git_sha": expected["source_git_sha"],
    "image": expected["image"],
    "limits": expected["limits"],
    "workload": {
      "command": expected["workload_command"],
      "docling_manifest_sha256": expected["docling_manifest_sha256"],
    },
    "repetitions": len(runs),
    "all_required_cases_passed": True,
    "pressure_events": {
      "max": sum(run["memory_max_events"] for run in runs),
      "oom": sum(run["memory_oom_events"] for run in runs),
      "oom_kill": sum(run["memory_oom_kill_events"] for run in runs),
    },
    "metrics": {
      "wall_seconds": _metrics([run["wall_seconds"] for run in runs]),
      "cpu_seconds": _metrics([run["cpu_seconds"] for run in runs]),
      "cgroup_memory_peak_bytes": _metrics([run["cgroup_memory_peak_bytes"] for run in runs]),
      "peak_pids": _metrics([run["peak_pids"] for run in runs]),
    },
    "runs": runs,
  }


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  with tempfile.NamedTemporaryFile(
    mode="w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False,
  ) as handle:
    json.dump(value, handle, indent=2, sort_keys=True)
    handle.write("\n")
    temporary = Path(handle.name)
  os.replace(temporary, path)


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--report", action="append", type=Path, required=True)
  parser.add_argument("--output", type=Path, required=True)
  args = parser.parse_args()
  summary = summarize(args.report)
  _atomic_json(args.output, summary)
  print(json.dumps(summary["metrics"], indent=2, sort_keys=True))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
