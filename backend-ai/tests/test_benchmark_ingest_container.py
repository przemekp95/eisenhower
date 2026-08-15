from pathlib import Path

import pytest

from scripts.benchmark_ingest_container import (
  CgroupSample,
  parse_cgroup_v2_path,
  summarize_samples,
  validate_limit,
)


def test_parses_only_the_unified_cgroup_v2_entry(tmp_path: Path):
  relative = parse_cgroup_v2_path(
    "9:memory:/legacy\n0::/system.slice/docker-task048.scope\n"
  )

  assert relative == Path("system.slice/docker-task048.scope")
  assert parse_cgroup_v2_path("9:memory:/legacy\n") is None


def test_summarizes_peak_memory_pids_and_cpu_without_claiming_an_idle_baseline():
  samples = [
    CgroupSample(elapsed_seconds=0.0, memory_current=100, memory_peak=120, pids=2, cpu_usec=10),
    CgroupSample(elapsed_seconds=0.2, memory_current=180, memory_peak=220, pids=5, cpu_usec=110_010),
    CgroupSample(elapsed_seconds=0.4, memory_current=90, memory_peak=220, pids=3, cpu_usec=210_010),
  ]

  assert summarize_samples(samples) == {
    "samples": 3,
    "first_memory_current_bytes": 100,
    "last_memory_current_bytes": 90,
    "peak_memory_current_bytes": 180,
    "cgroup_memory_peak_bytes": 220,
    "peak_pids": 5,
    "cpu_seconds": 0.21,
    "wall_seconds_sampled": 0.4,
    "average_cpu_cores": 0.525,
  }


@pytest.mark.parametrize(("name", "value"), [("memory", "0"), ("cpus", ""), ("pids", "unlimited")])
def test_rejects_missing_or_unbounded_benchmark_limits(name, value):
  with pytest.raises(ValueError, match=name):
    validate_limit(name, value)
