from pathlib import Path
import subprocess
import sys


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPOSITORY_ROOT / "backend-ai/scripts/run_ragops_candidate.py"


def test_ragops_candidate_requires_explicit_store_endpoints(tmp_path):
  completed = subprocess.run(
    [
      sys.executable,
      str(SCRIPT),
      "--registry", str(tmp_path / "registry"),
      "--candidate-id", "task065-test",
      "--git-sha", "a" * 40,
      "--output", str(tmp_path / "report.json"),
    ],
    cwd=REPOSITORY_ROOT,
    text=True,
    capture_output=True,
    check=False,
  )

  assert completed.returncode == 2
  assert "--mongo-uri" in completed.stderr
  assert "--qdrant-url" in completed.stderr
