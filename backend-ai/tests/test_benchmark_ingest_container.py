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
    CgroupSample(elapsed_seconds=0.0, memory_current=100, memory_peak=120, pids=2, cpu_usec=10, memory_max_events=0, memory_oom_events=0, memory_oom_kill_events=0),
    CgroupSample(elapsed_seconds=0.2, memory_current=180, memory_peak=220, pids=5, cpu_usec=110_010, memory_max_events=3, memory_oom_events=1, memory_oom_kill_events=0),
    CgroupSample(elapsed_seconds=0.4, memory_current=90, memory_peak=220, pids=3, cpu_usec=210_010, memory_max_events=5, memory_oom_events=1, memory_oom_kill_events=0),
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
    "memory_max_events": 5,
    "memory_oom_events": 1,
    "memory_oom_kill_events": 0,
  }


@pytest.mark.parametrize(("name", "value"), [("memory", "0"), ("cpus", ""), ("pids", "unlimited")])
def test_rejects_missing_or_unbounded_benchmark_limits(name, value):
  with pytest.raises(ValueError, match=name):
    validate_limit(name, value)


def test_container_benchmark_routes_library_caches_to_its_bounded_tmpfs():
  script = (Path(__file__).resolve().parents[1] / "scripts" / "benchmark_ingest_container.py").read_text()

  assert '"NUMBA_CACHE_DIR=/tmp/numba"' in script
  assert '"MPLCONFIGDIR=/tmp/matplotlib"' in script
  assert '"XDG_CACHE_HOME=/tmp/cache"' in script
