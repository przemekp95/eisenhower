from __future__ import annotations

from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
import fcntl
from hashlib import sha256
import hmac
import json
import os
from pathlib import Path
from typing import Any, Callable, Iterator
from uuid import uuid4

from app.audit import AuditAction, AuditError, AuditEvent, AuditOutcome, SqliteAuditSink
from app.artifacts.models import CandidateManifest


PHASES = ("retrieval", "generation", "response", "mag")
TRANSITIONS = {"disabled": {"shadow"}, "shadow": {"canary"}, "canary": {"enabled"}, "enabled": set()}
PHASE_WORKFLOWS = {
  "retrieval": "ragops",
  "generation": "llmops",
  "response": "llmops",
  "mag": "llmops",
}
AUTOMATED_APPROVER_IDENTITIES = {"self", "automation", "bot", "ci", "system", "unknown"}


class PromotionBlocked(RuntimeError):
  """Raised when a fail-closed promotion or rollback gate is not satisfied."""


def stable_canary_assignment(subject_pseudonym: str, candidate_id: str, phase: str, percent: int) -> bool:
  if not 0 <= percent <= 100:
    raise ValueError("canary percent must be between zero and one hundred")
  bucket = int.from_bytes(
    sha256(f"{phase}:{candidate_id}:{subject_pseudonym}".encode()).digest()[:8], "big"
  ) % 10_000
  return bucket < percent * 100


def verify_hmac_approval(approval: dict[str, Any], key: bytes) -> bool:
  signature = approval.get("signature")
  if not isinstance(signature, str) or len(signature) != 64:
    return False
  payload = {name: value for name, value in approval.items() if name != "signature"}
  encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
  expected = hmac.new(key, encoded, sha256).hexdigest()
  return hmac.compare_digest(signature, expected)


class PromotionController:
  """Atomic local pointer controller; deployment and traffic routing remain external."""

  def __init__(
    self,
    root: str | Path,
    *,
    candidate_verifier: Callable[[str], Any] | None = None,
    approval_verifier: Callable[[dict[str, Any]], bool] | None = None,
    audit_sink: SqliteAuditSink | None = None,
    release_sha: str | None = None,
  ):
    self.root = Path(root).resolve()
    self.history = self.root / "history"
    self.current_path = self.root / "current.json"
    self.lock_path = self.root / ".lock"
    self.candidate_verifier = candidate_verifier
    self.approval_verifier = approval_verifier
    self.audit_sink = audit_sink
    self.release_sha = release_sha
    if (audit_sink is None) != (release_sha is None):
      raise ValueError("audit_sink and release_sha must be configured together")
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
    request_id: str | None = None,
  ) -> dict[str, Any]:
    audit_request_id = request_id or f"rollout-{uuid4().hex}"
    actor_id = str(approval.get("approved_by", "")).strip() or "unverified-actor"
    resource = f"{phase}:{target_mode}:{candidate_id}"
    with self._locked():
      self._require_applied_audit(dry_run)
      self._record_audit(
        action=AuditAction.ROLLOUT_DECISION,
        outcome=AuditOutcome.ATTEMPT,
        actor_id=actor_id,
        resource_id=f"{resource}:attempt",
        request_id=audit_request_id,
      )
      try:
        current = self.read()
        self._validate_transition(
          current, phase, target_mode, candidate_id, canary_percent, quality_report, approval
        )
      except PromotionBlocked:
        self._record_audit(
          action=AuditAction.ROLLOUT_DECISION,
          outcome=AuditOutcome.REJECTED,
          actor_id=actor_id,
          resource_id=f"{resource}:result",
          request_id=audit_request_id,
        )
        raise
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
      self._record_audit(
        action=AuditAction.ROLLOUT_DECISION,
        outcome=AuditOutcome.SUCCESS,
        actor_id=actor_id,
        resource_id=f"{resource}:result",
        request_id=audit_request_id,
      )
      if not dry_run:
        self._write_history(current)
        self._write(proposed)
      return proposed

  def rollback(
    self,
    *,
    actor_id: str = "rollout-operator",
    request_id: str | None = None,
  ) -> dict[str, Any]:
    audit_request_id = request_id or f"rollback-{uuid4().hex}"
    with self._locked():
      try:
        self._require_applied_audit(False)
        self._record_audit(
          action=AuditAction.ROLLBACK_DECISION,
          outcome=AuditOutcome.ATTEMPT,
          actor_id=actor_id,
          resource_id="rollback:attempt",
          request_id=audit_request_id,
        )
        current = self.read()
        previous = current.get("previous_revision")
        if previous is None:
          raise PromotionBlocked("rollback history is empty")
        history_path = self.history / f"{previous}.json"
        try:
          restored = json.loads(history_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as issue:
          raise PromotionBlocked("rollback pointer is missing or invalid") from issue
      except PromotionBlocked:
        self._record_audit(
          action=AuditAction.ROLLBACK_DECISION,
          outcome=AuditOutcome.REJECTED,
          actor_id=actor_id,
          resource_id="rollback:result",
          request_id=audit_request_id,
        )
        raise
      self._record_audit(
        action=AuditAction.ROLLBACK_DECISION,
        outcome=AuditOutcome.SUCCESS,
        actor_id=actor_id,
        resource_id=f"rollback:{previous}:result",
        request_id=audit_request_id,
      )
      self._write(restored)
      return restored

  def _require_applied_audit(self, dry_run: bool) -> None:
    if not dry_run and self.audit_sink is None:
      raise PromotionBlocked("durable audit is required before an applied rollout decision")

  def _record_audit(
    self,
    *,
    action: AuditAction,
    outcome: AuditOutcome,
    actor_id: str,
    resource_id: str,
    request_id: str,
  ) -> None:
    if self.audit_sink is None:
      return
    try:
      self.audit_sink.record(AuditEvent(
        service="promotion-controller",
        release_sha=str(self.release_sha),
        event_id=f"promotion-{uuid4().hex}",
        request_id=request_id,
        action=action,
        outcome=outcome,
        tenant_id="deployment",
        actor_id=actor_id,
        resource_id=resource_id,
      ))
    except (AuditError, TypeError, ValueError) as issue:
      raise PromotionBlocked("durable audit is unavailable") from issue

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
    if not isinstance(verified, CandidateManifest):
      raise PromotionBlocked("immutable candidate verification failed")
    if verified.candidate_id != candidate_id:
      raise PromotionBlocked("immutable candidate identity mismatch")
    if verified.workflow != PHASE_WORKFLOWS[phase]:
      raise PromotionBlocked("candidate workflow does not match promotion phase")
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
    now = datetime.now(UTC)
    if generated_at.tzinfo is None:
      raise PromotionBlocked("quality report timestamp is invalid")
    generated_at_utc = generated_at.astimezone(UTC)
    if generated_at_utc > now + timedelta(minutes=5):
      raise PromotionBlocked("quality report timestamp is in the future")
    if now - generated_at_utc > timedelta(hours=24):
      raise PromotionBlocked("quality report is stale")
    if approval.get("phase") != phase or approval.get("candidate_id") != candidate_id:
      raise PromotionBlocked("approval does not match phase and candidate")
    if approval.get("approval_source") != "owner_out_of_band" or approval.get("decision") != "approved":
      raise PromotionBlocked("approval is not an explicit out-of-band owner decision")
    approved_by = str(approval.get("approved_by", "")).strip()
    if not approved_by or approved_by.casefold() in AUTOMATED_APPROVER_IDENTITIES:
      raise PromotionBlocked("approval receipt is incomplete")
    try:
      approved_at = datetime.fromisoformat(str(approval["approved_at"]))
    except (KeyError, ValueError) as issue:
      raise PromotionBlocked("approval timestamp is invalid") from issue
    if approved_at.tzinfo is None:
      raise PromotionBlocked("approval timestamp must be timezone-aware")
    now = datetime.now(UTC)
    approved_at_utc = approved_at.astimezone(UTC)
    if approved_at_utc > now + timedelta(minutes=5):
      raise PromotionBlocked("approval timestamp is in the future")
    if self.approval_verifier is None:
      raise PromotionBlocked("trusted human approval verifier is not configured")
    try:
      approval_verified = self.approval_verifier(approval)
    except Exception as issue:
      raise PromotionBlocked("trusted human approval verification failed") from issue
    if approval_verified is not True:
      raise PromotionBlocked("trusted human approval verification failed")

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
