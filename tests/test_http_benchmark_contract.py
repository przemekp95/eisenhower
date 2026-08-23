from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RESULT = ROOT / "benchmarks" / "results" / "nest-fastify-migration.json"
REPORT = ROOT / "docs" / "benchmarks" / "2026-08-23-express-vs-nest-fastify.md"


def test_benchmark_method_and_results_are_complete():
  result = json.loads(RESULT.read_text(encoding="utf-8"))
  method = result["method"]

  assert result["baseline"]["sha"] == "5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9"
  assert result["candidate"]["sha"]
  assert method["implementations"] == ["express", "nest-fastify"]
  assert method["storage"] == ["memory", "mongo"]
  assert method["scenarios"] == ["liveness", "task-list", "task-create"]
  assert method["concurrency"] == [1, 10, 50]
  assert method["repetitions"] >= 5
  assert method["warmup_seconds"] >= 5
  assert method["measurement_seconds"] >= 15
  assert method["cold_starts"] >= 10
  assert method["cold_start_paths"] == ["/health", "/health/ready"]
  assert method["alternating_order"] is True
  assert result["environment"]["node"]
  assert result["environment"]["cpu"]
  assert result["environment"]["kernel"]

  expected_samples = 2 * 2 * 3 * 3 * method["repetitions"]
  assert len(result["samples"]) == expected_samples
  for sample in result["samples"]:
    assert sample["count"] > 0
    assert sample["throughput_rps"] > 0
    assert 0 <= sample["p50_ms"] <= sample["p95_ms"] <= sample["p99_ms"]
    assert sample["rss_bytes"] > 0
    assert sample["order"] in (0, 1)
  assert len(result["cold_start_samples"]) == 2 * 2 * method["cold_starts"]
  for sample in result["cold_start_samples"]:
    assert sample["liveness_duration_ms"] > 0
    assert sample["readiness_duration_ms"] > 0
    assert sample["server_ready_duration_ms"] > 0
    assert sample["rss_bytes"] > 0


def test_benchmark_report_is_explicitly_synthetic_and_reports_regressions():
  report = REPORT.read_text(encoding="utf-8")

  assert "syntetyczny" in report.lower()
  assert "nie jest dowodem produkcyjnym" in report.lower()
  assert "p50" in report and "p95" in report and "p99" in report
  assert "throughput" in report.lower() and "RSS" in report
  assert "cold start" in report.lower()
  assert "liveness" in report.lower() and "readiness" in report.lower()
  assert "regres" in report.lower()
  assert "5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9" in report
