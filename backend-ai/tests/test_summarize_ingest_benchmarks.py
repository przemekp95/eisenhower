from copy import deepcopy
from hashlib import sha256
import json

import pytest

from scripts.summarize_ingest_benchmarks import BenchmarkSetRejected, summarize


def report(*, wall: float, peak: int, cpu: float, recorded_at: str) -> dict:
  cases = [{"required_phrases_present": True} for _ in range(11)]
  return {
    "schema_version": "runtime-role-container-benchmark-v1",
    "recorded_at": recorded_at,
    "role": "ingest-document-extraction",
    "source_git_sha": "a" * 40,
    "source_git_dirty": False,
    "image": {
      "id": "sha256:" + "b" * 64,
      "reference": "local/ingest:" + "a" * 40,
      "source_revision": "a" * 40,
      "runtime_role": "ingest",
    },
    "limits": {"memory": "2g", "cpus": "2.0", "pids": "256"},
    "workload": {
      "command": "scripts/benchmark_document_extraction.py",
      "docling_manifest_sha256": "c" * 64,
    },
    "result": {
      "exit_code": 0,
      "oom_killed": False,
      "timed_out": False,
      "wall_seconds": wall,
      "cgroup": {
        "cgroup_memory_peak_bytes": peak,
        "cpu_seconds": cpu,
        "peak_pids": 7,
        "memory_max_events": 0,
        "memory_oom_events": 0,
        "memory_oom_kill_events": 0,
      },
    },
    "workload_report": {"cases": cases},
  }


def write_report(tmp_path, name: str, value: dict):
  path = tmp_path / name
  path.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")
  return path


def test_summarizes_only_comparable_clean_successful_runs(tmp_path):
  paths = [
    write_report(tmp_path, "one.json", report(wall=10, peak=100, cpu=7, recorded_at="2026-08-15T01:00:00Z")),
    write_report(tmp_path, "two.json", report(wall=12, peak=120, cpu=8, recorded_at="2026-08-15T01:01:00Z")),
    write_report(tmp_path, "three.json", report(wall=14, peak=140, cpu=9, recorded_at="2026-08-15T01:02:00Z")),
  ]

  summary = summarize(paths)

  assert summary["schema_version"] == "runtime-role-repetition-summary-v1"
  assert summary["repetitions"] == 3
  assert summary["metrics"]["wall_seconds"] == {
    "minimum": 10.0, "median": 12.0, "p95": 13.8, "maximum": 14.0,
  }
  assert summary["metrics"]["cgroup_memory_peak_bytes"]["maximum"] == 140
  assert summary["pressure_events"] == {"max": 0, "oom": 0, "oom_kill": 0}
  assert summary["all_required_cases_passed"] is True
  assert summary["runs"][0]["report_sha256"] == sha256(paths[0].read_bytes()).hexdigest()


@pytest.mark.parametrize("mutation", ("dirty", "image", "limit", "oom", "cases"))
def test_rejects_noncomparable_or_failed_evidence(tmp_path, mutation):
  first = report(wall=10, peak=100, cpu=7, recorded_at="2026-08-15T01:00:00Z")
  second = deepcopy(first)
  if mutation == "dirty":
    second["source_git_dirty"] = True
  elif mutation == "image":
    second["image"]["id"] = "sha256:" + "d" * 64
  elif mutation == "limit":
    second["limits"]["memory"] = "1g"
  elif mutation == "oom":
    second["result"]["oom_killed"] = True
  else:
    second["workload_report"]["cases"] = second["workload_report"]["cases"][:-1]

  paths = [
    write_report(tmp_path, "one.json", first),
    write_report(tmp_path, "two.json", second),
    write_report(tmp_path, "three.json", first),
  ]

  with pytest.raises(BenchmarkSetRejected):
    summarize(paths)
