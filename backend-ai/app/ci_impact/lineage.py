from __future__ import annotations

from hashlib import sha256
from pathlib import Path


def implementation_checksum(project_root: Path) -> str:
  package = project_root / "app/ci_impact"
  digest = sha256()
  files = sorted(path for path in package.glob("*.py") if path.is_file())
  files.extend(
    project_root / "scripts" / name
    for name in (
      "collect_ci_impact_history.py",
      "run_ci_impact_shadow.py",
      "train_ci_impact_candidate.py",
    )
  )
  if not files:
    raise ValueError("CI impact implementation files are missing")
  for path in files:
    if not path.is_file():
      raise ValueError("CI impact implementation files are incomplete")
    payload = path.read_bytes()
    digest.update(path.relative_to(project_root).as_posix().encode())
    digest.update(b"\0")
    digest.update(len(payload).to_bytes(8, "big"))
    digest.update(payload)
  return digest.hexdigest()
