#!/usr/bin/env python3
from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from time import monotonic, sleep
from typing import Any
from uuid import uuid4


CGROUP_ROOT = Path("/sys/fs/cgroup")


@dataclass(frozen=True)
class CgroupSample:
  elapsed_seconds: float
  memory_current: int
  memory_peak: int
  pids: int
  cpu_usec: int


def parse_cgroup_v2_path(content: str) -> Path | None:
  for line in content.splitlines():
    hierarchy, controllers, raw_path = line.split(":", maxsplit=2)
    if hierarchy == "0" and controllers == "":
      relative = Path(raw_path.removeprefix("/"))
      if ".." in relative.parts:
        raise ValueError("cgroup path must not escape the unified hierarchy")
      return relative
  return None


def validate_limit(name: str, value: str) -> str:
  if value.strip().lower() in {"", "0", "none", "unlimited", "infinity", "max"}:
    raise ValueError(f"{name} benchmark limit must be finite and non-zero")
  return value


def summarize_samples(samples: list[CgroupSample]) -> dict[str, int | float | None]:
  if not samples:
    return {
      "samples": 0,
      "first_memory_current_bytes": None,
      "last_memory_current_bytes": None,
      "peak_memory_current_bytes": None,
      "cgroup_memory_peak_bytes": None,
      "peak_pids": None,
      "cpu_seconds": None,
      "wall_seconds_sampled": None,
      "average_cpu_cores": None,
    }
  wall = samples[-1].elapsed_seconds - samples[0].elapsed_seconds
  cpu_seconds = max(0, samples[-1].cpu_usec - samples[0].cpu_usec) / 1_000_000
  return {
    "samples": len(samples),
    "first_memory_current_bytes": samples[0].memory_current,
    "last_memory_current_bytes": samples[-1].memory_current,
    "peak_memory_current_bytes": max(sample.memory_current for sample in samples),
    "cgroup_memory_peak_bytes": max(sample.memory_peak for sample in samples),
    "peak_pids": max(sample.pids for sample in samples),
    "cpu_seconds": round(cpu_seconds, 6),
    "wall_seconds_sampled": round(wall, 6),
    "average_cpu_cores": round(cpu_seconds / wall, 6) if wall > 0 else None,
  }


def _run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
  return subprocess.run(command, check=check, capture_output=True, text=True)


def _read_int(path: Path) -> int:
  return int(path.read_text(encoding="utf-8").strip())


def _read_cpu_usage(cgroup: Path) -> int:
  values = {
    key: int(value)
    for key, value in (
      line.split(maxsplit=1)
      for line in (cgroup / "cpu.stat").read_text(encoding="utf-8").splitlines()
    )
  }
  return values["usage_usec"]


def _sample(cgroup: Path, elapsed: float) -> CgroupSample:
  return CgroupSample(
    elapsed_seconds=round(elapsed, 6),
    memory_current=_read_int(cgroup / "memory.current"),
    memory_peak=_read_int(cgroup / "memory.peak"),
    pids=_read_int(cgroup / "pids.current"),
    cpu_usec=_read_cpu_usage(cgroup),
  )


def _atomic_json(path: Path, report: dict[str, Any]) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  with tempfile.NamedTemporaryFile(
    mode="w",
    encoding="utf-8",
    dir=path.parent,
    prefix=f".{path.name}.",
    delete=False,
  ) as handle:
    json.dump(report, handle, indent=2, ensure_ascii=False, sort_keys=True)
    handle.write("\n")
    temporary = Path(handle.name)
  os.replace(temporary, path)


def _git_evidence(workspace: Path) -> dict[str, Any]:
  sha = _run(["git", "-C", str(workspace), "rev-parse", "HEAD"]).stdout.strip()
  dirty = bool(_run(
    ["git", "-C", str(workspace), "status", "--porcelain"],
  ).stdout.strip())
  return {"source_git_sha": sha, "source_git_dirty": dirty}


def _image_evidence(image: str) -> dict[str, Any]:
  raw = _run(["docker", "image", "inspect", image]).stdout
  inspected = json.loads(raw)[0]
  labels = inspected.get("Config", {}).get("Labels") or {}
  return {
    "reference": image,
    "id": inspected["Id"],
    "source_revision": labels.get("org.opencontainers.image.revision"),
    "runtime_role": labels.get("eisenhower.runtime.role"),
  }


def run_benchmark(args: argparse.Namespace) -> dict[str, Any]:
  memory = validate_limit("memory", args.memory)
  cpus = validate_limit("cpus", args.cpus)
  pids = validate_limit("pids", args.pids)
  workspace = args.workspace.resolve()
  docling_artifacts = args.docling_artifacts.resolve()
  if not (docling_artifacts / "manifest.json").is_file():
    raise ValueError("Docling artifact manifest is missing")
  container_name = f"eisenhower-task048-ingest-benchmark-{uuid4().hex[:12]}"
  command = [
    "docker", "create",
    "--name", container_name,
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
    "--memory", memory,
    "--cpus", cpus,
    "--pids-limit", pids,
    "--env", "HF_HUB_OFFLINE=1",
    "--env", "TRANSFORMERS_OFFLINE=1",
    "--env", "APP_ENV=production",
    "--env", "DOCLING_ARTIFACTS_PATH=/app/docling-artifacts",
    "--env", f"DOCLING_ARTIFACTS_MANIFEST_SHA256={args.docling_manifest_sha256}",
    "--env", "TOKENIZERS_PARALLELISM=false",
    "--env", "OMP_NUM_THREADS=1",
    "--env", "TORCH_NUM_THREADS=1",
    "--env", "HOME=/tmp/home",
    "--env", "NUMBA_CACHE_DIR=/tmp/numba",
    "--env", "MPLCONFIGDIR=/tmp/matplotlib",
    "--env", "XDG_CACHE_HOME=/tmp/cache",
    "--env", "PYTHONUSERBASE=/home/app/.local",
    "--env", "PYTHONPATH=/workspace/backend-ai",
    "--volume", f"{workspace}:/workspace:ro",
    "--volume", f"{args.model_cache_volume}:/home/app/.cache/huggingface:ro",
    "--volume", f"{docling_artifacts}:/app/docling-artifacts:ro",
    "--workdir", "/workspace/backend-ai",
    "--entrypoint", "python",
    args.image,
    "scripts/benchmark_document_extraction.py",
  ]
  created = _run(command).stdout.strip()
  samples: list[CgroupSample] = []
  timed_out = False
  started_at = monotonic()
  try:
    _run(["docker", "start", container_name])
    pid = 0
    deadline = started_at + args.timeout_seconds
    while pid <= 0 and monotonic() < deadline:
      pid = int(_run([
        "docker", "inspect", "--format", "{{.State.Pid}}", container_name
      ]).stdout.strip())
      if pid <= 0:
        sleep(0.02)
    if pid <= 0:
      raise RuntimeError("benchmark container never exposed a running PID")
    relative = parse_cgroup_v2_path(
      Path(f"/proc/{pid}/cgroup").read_text(encoding="utf-8")
    )
    if relative is None:
      raise RuntimeError("unified cgroup v2 path is unavailable")
    cgroup = CGROUP_ROOT / relative
    while True:
      elapsed = monotonic() - started_at
      try:
        samples.append(_sample(cgroup, elapsed))
      except FileNotFoundError:
        break
      state = json.loads(_run([
        "docker", "inspect", "--format", "{{json .State}}", container_name
      ]).stdout)
      if not state["Running"]:
        break
      if monotonic() >= deadline:
        timed_out = True
        _run(["docker", "stop", "--time", "5", container_name], check=False)
        break
      sleep(args.sample_interval_seconds)

    state = json.loads(_run([
      "docker", "inspect", "--format", "{{json .State}}", container_name
    ]).stdout)
    logs = _run(["docker", "logs", container_name], check=False)
    workload_report = None
    if logs.stdout.strip():
      try:
        workload_report = json.loads(logs.stdout)
      except json.JSONDecodeError:
        workload_report = {"unparsed_stdout": logs.stdout[-8_192:]}
    report = {
      "schema_version": "runtime-role-container-benchmark-v1",
      "recorded_at": datetime.now(UTC).isoformat(),
      "role": "ingest-document-extraction",
      "evidence_level": "local-isolated-container",
      "deployment_proven": False,
      "production_proven": False,
      **_git_evidence(workspace),
      "image": _image_evidence(args.image),
      "container_id": created,
      "limits": {"memory": memory, "cpus": cpus, "pids": pids},
      "workload": {
        "command": "scripts/benchmark_document_extraction.py",
        "fixture_scope": "repository-approved synthetic extraction fixtures",
        "model_cache_read_only": True,
        "docling_artifacts_read_only": True,
        "docling_manifest_sha256": args.docling_manifest_sha256,
        "workspace_read_only": True,
        "network_expected": False,
      },
      "result": {
        "exit_code": state["ExitCode"],
        "oom_killed": state["OOMKilled"],
        "timed_out": timed_out,
        "wall_seconds": round(monotonic() - started_at, 6),
        "state_error": state.get("Error") or None,
        "stderr_tail": logs.stderr[-8_192:] or None,
        "cgroup": summarize_samples(samples),
      },
      "workload_report": workload_report,
      "samples": [asdict(sample) for sample in samples],
    }
    return report
  finally:
    if not args.keep_container:
      _run(["docker", "rm", "--force", container_name], check=False)


def _matches_expectation(report: dict[str, Any], expectation: str) -> bool:
  result = report["result"]
  if expectation == "any":
    return True
  if expectation == "success":
    return result["exit_code"] == 0 and not result["oom_killed"] and not result["timed_out"]
  if expectation == "oom":
    return bool(result["oom_killed"])
  return result["exit_code"] != 0 or result["oom_killed"] or result["timed_out"]


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser()
  parser.add_argument("--image", required=True)
  parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parents[2])
  parser.add_argument(
    "--model-cache-volume",
    default="eisenhower-local-production_model_cache",
  )
  parser.add_argument("--docling-artifacts", type=Path, required=True)
  parser.add_argument("--docling-manifest-sha256", required=True)
  parser.add_argument("--memory", required=True)
  parser.add_argument("--cpus", required=True)
  parser.add_argument("--pids", required=True)
  parser.add_argument("--timeout-seconds", type=float, default=600.0)
  parser.add_argument("--sample-interval-seconds", type=float, default=0.1)
  parser.add_argument("--expect", choices=("success", "failure", "oom", "any"), default="success")
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument("--keep-container", action="store_true")
  return parser.parse_args()


def main() -> int:
  args = parse_args()
  report = run_benchmark(args)
  _atomic_json(args.output, report)
  print(json.dumps({
    "output": str(args.output),
    "result": report["result"],
  }, indent=2, sort_keys=True))
  return 0 if _matches_expectation(report, args.expect) else 1


if __name__ == "__main__":
  sys.exit(main())
