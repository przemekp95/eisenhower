from __future__ import annotations

from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
import fcntl
from hashlib import sha256
import json
import os
from pathlib import Path
from typing import Any, Callable, Iterator


PHASES = ("retrieval", "generation", "response", "mag")
TRANSITIONS = {"disabled": {"shadow"}, "shadow": {"canary"}, "canary": {"enabled"}, "enabled": set()}


class PromotionBlocked(RuntimeError):
  """Raised when a fail-closed promotion or rollback gate is not satisfied."""


def stable_canary_assignment(subject_pseudonym: str, candidate_id: str, phase: str, percent: int) -> bool:
  if not 0 <= percent <= 100:
    raise ValueError("canary percent must be between zero and one hundred")
  bucket = int.from_bytes(
    sha256(f"{phase}:{candidate_id}:{subject_pseudonym}".encode()).digest()[:8], "big"
  ) % 10_000
  return bucket < percent * 100


class PromotionController:
  """Atomic local pointer controller; deployment and traffic routing remain external."""

  def __init__(
    self,
    root: str | Path,
    *,
    candidate_verifier: Callable[[str], Any] | None = None,
  ):
    self.root = Path(root).resolve()
    self.history = self.root / "history"
    self.current_path = self.root / "current.json"
    self.lock_path = self.root / ".lock"
    self.candidate_verifier = candidate_verifier
    for directory in (self.root, self.history):
      directory.mkdir(parents=True, exist_ok=True, mode=0o700)
      directory.chmod(0o700)
    if not self.current_path.exists():
      self._write({
        "schema_version": "ai-promotion-pointer-v1",
        "revision": 0,
        "previous_revision": None,
        "phases": {
          phase: {"mode": "disabled", "candidate_id": None, "canary_percent": 0}
          for phase in PHASES
        },
      })

  def read(self) -> dict[str, Any]:
    try:
      state = json.loads(self.current_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as issue:
      raise PromotionBlocked("promotion pointer is unreadable") from issue
    if set(state.get("phases", {})) != set(PHASES):
      raise PromotionBlocked("promotion pointer phase contract is invalid")
    return state

  def transition(
    self,
    *,
    phase: str,
    target_mode: str,
    candidate_id: str,
    canary_percent: int,
    quality_report: dict[str, Any],
    approval: dict[str, Any],
    dry_run: bool,
  ) -> dict[str, Any]:
    with self._locked():
      current = self.read()
      self._validate_transition(
        current, phase, target_mode, candidate_id, canary_percent, quality_report, approval
      )
      phases = json.loads(json.dumps(current["phases"]))
      phases[phase] = {
        "mode": target_mode,
        "candidate_id": candidate_id,
        "canary_percent": canary_percent,
        "quality_report_checksum": quality_report["report_checksum"],
        "approval_checksum": self._checksum(approval),
      }
      proposed = {
        **current,
        "revision": int(current["revision"]) + 1,
        "previous_revision": int(current["revision"]),
        "phases": phases,
      }
      if not dry_run:
        self._write_history(current)
        self._write(proposed)
      return proposed

  def rollback(self) -> dict[str, Any]:
    with self._locked():
      current = self.read()
      previous = current.get("previous_revision")
      if previous is None:
        raise PromotionBlocked("rollback history is empty")
      history_path = self.history / f"{previous}.json"
      try:
        restored = json.loads(history_path.read_text(encoding="utf-8"))
      except (OSError, json.JSONDecodeError) as issue:
        raise PromotionBlocked("rollback pointer is missing or invalid") from issue
      self._write(restored)
      return restored

  def _validate_transition(
    self,
    current: dict[str, Any],
    phase: str,
    target_mode: str,
    candidate_id: str,
    canary_percent: int,
    report: dict[str, Any],
    approval: dict[str, Any],
  ) -> None:
    if phase not in PHASES:
      raise PromotionBlocked("unknown promotion phase")
    if self.candidate_verifier is None:
      raise PromotionBlocked("immutable candidate verifier is not configured")
    try:
      verified = self.candidate_verifier(candidate_id)
    except Exception as issue:
      raise PromotionBlocked("immutable candidate verification failed") from issue
    if verified is None or verified is False:
      raise PromotionBlocked("immutable candidate verification failed")
    current_mode = current["phases"][phase]["mode"]
    if target_mode not in TRANSITIONS.get(current_mode, set()):
      raise PromotionBlocked(f"illegal transition from {current_mode} to {target_mode}")
    dependencies = {
      "generation": ("retrieval",),
      "response": ("retrieval", "generation"),
      "mag": ("response",),
    }.get(phase, ())
    if any(current["phases"][dependency]["mode"] == "disabled" for dependency in dependencies):
      raise PromotionBlocked("promotion dependency is disabled")
    expected_percent = 0 if target_mode == "shadow" else 100 if target_mode == "enabled" else None
    if expected_percent is not None and canary_percent != expected_percent:
      raise PromotionBlocked("canary percent does not match target mode")
    if target_mode == "canary" and not 1 <= canary_percent <= 99:
      raise PromotionBlocked("canary transition requires a bounded percentage")
    if report.get("status") != "green":
      raise PromotionBlocked("quality report is not green")
    if report.get("current_candidate_id") != candidate_id:
      raise PromotionBlocked("quality report candidate mismatch")
    report_payload = {key: value for key, value in report.items() if key != "report_checksum"}
    if report.get("report_checksum") != self._checksum(report_payload):
      raise PromotionBlocked("quality report checksum mismatch")
    try:
      generated_at = datetime.fromisoformat(str(report["generated_at"]))
    except (KeyError, ValueError) as issue:
      raise PromotionBlocked("quality report timestamp is invalid") from issue
    if generated_at.tzinfo is None or datetime.now(UTC) - generated_at.astimezone(UTC) > timedelta(hours=24):
      raise PromotionBlocked("quality report is stale")
    if approval.get("phase") != phase or approval.get("candidate_id") != candidate_id:
      raise PromotionBlocked("approval does not match phase and candidate")
    if not approval.get("approved_by") or not approval.get("approved_at"):
      raise PromotionBlocked("approval receipt is incomplete")

  def _write_history(self, state: dict[str, Any]) -> None:
    target = self.history / f"{state['revision']}.json"
    if target.exists():
      if json.loads(target.read_text(encoding="utf-8")) != state:
        raise PromotionBlocked("rollback history conflict")
      return
    self._exclusive_write(target, state)

  def _write(self, state: dict[str, Any]) -> None:
    temporary = self.root / f".{os.getpid()}.current.json"
    data = (json.dumps(state, indent=2, sort_keys=True) + "\n").encode()
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
      with os.fdopen(descriptor, "wb", closefd=False) as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    finally:
      os.close(descriptor)
    os.replace(temporary, self.current_path)
    self.current_path.chmod(0o600)

  @staticmethod
  def _exclusive_write(target: Path, state: dict[str, Any]) -> None:
    data = (json.dumps(state, indent=2, sort_keys=True) + "\n").encode()
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
      os.write(descriptor, data)
      os.fsync(descriptor)
    finally:
      os.close(descriptor)

  @staticmethod
  def _checksum(value: dict[str, Any]) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()

  @contextmanager
  def _locked(self) -> Iterator[None]:
    with self.lock_path.open("a+", encoding="utf-8") as lock:
      fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
      try:
        yield
      finally:
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
