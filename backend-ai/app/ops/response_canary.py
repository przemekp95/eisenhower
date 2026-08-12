from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
import json
from pathlib import Path
from typing import Callable

from .promotion import PHASES, stable_canary_assignment


@dataclass(frozen=True)
class ResponseCanaryDecision:
  allowed: bool
  reason: str | None

  @property
  def outcome(self) -> str:
    if self.allowed:
      return "selected"
    return {
      "response_canary_not_selected": "not_selected",
      "response_promotion_disabled": "promotion_disabled",
      "response_promotion_unavailable": "promotion_unavailable",
      "response_promotion_invalid": "promotion_invalid",
      "response_approval_expired": "approval_expired",
    }.get(self.reason, "other")


class ResponseCanaryRouter:
  """Fail-closed response routing backed by the atomic promotion pointer."""

  def __init__(
    self,
    pointer_path: str | Path,
    *,
    candidate_id: str,
    now: Callable[[], datetime] | None = None,
  ) -> None:
    self.pointer_path = Path(pointer_path)
    self.candidate_id = candidate_id
    self._now = now or (lambda: datetime.now(UTC))

  def evaluate(self, tenant_id: str, user_id: str) -> ResponseCanaryDecision:
    try:
      pointer = json.loads(self.pointer_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
      return ResponseCanaryDecision(False, "response_promotion_unavailable")

    response = self._validated_response_phase(pointer)
    if response is None:
      return ResponseCanaryDecision(False, "response_promotion_invalid")
    if response["mode"] not in {"canary", "enabled"}:
      return ResponseCanaryDecision(False, "response_promotion_disabled")

    try:
      valid_until = datetime.fromisoformat(response["approval_valid_until"])
    except (TypeError, ValueError):
      return ResponseCanaryDecision(False, "response_promotion_invalid")
    if valid_until.tzinfo is None:
      return ResponseCanaryDecision(False, "response_promotion_invalid")
    if self._now().astimezone(UTC) >= valid_until.astimezone(UTC):
      return ResponseCanaryDecision(False, "response_approval_expired")

    percent = response["canary_percent"]
    if response["mode"] == "enabled":
      return ResponseCanaryDecision(True, None)
    subject_pseudonym = sha256(f"{tenant_id}\0{user_id}".encode()).hexdigest()
    if stable_canary_assignment(subject_pseudonym, self.candidate_id, "response", percent):
      return ResponseCanaryDecision(True, None)
    return ResponseCanaryDecision(False, "response_canary_not_selected")

  def _validated_response_phase(self, pointer: object) -> dict | None:
    if not isinstance(pointer, dict) or pointer.get("schema_version") != "ai-promotion-pointer-v1":
      return None
    if not isinstance(pointer.get("revision"), int) or pointer["revision"] < 0:
      return None
    phases = pointer.get("phases")
    if not isinstance(phases, dict) or set(phases) != set(PHASES):
      return None
    response = phases.get("response")
    if not isinstance(response, dict) or response.get("candidate_id") != self.candidate_id:
      return None
    mode = response.get("mode")
    percent = response.get("canary_percent")
    if mode == "canary" and (not isinstance(percent, int) or not 1 <= percent <= 99):
      return None
    if mode == "enabled" and percent != 100:
      return None
    if mode not in {"disabled", "shadow", "canary", "enabled"}:
      return None
    for field in ("quality_report_checksum", "approval_checksum"):
      checksum = response.get(field)
      if mode in {"canary", "enabled"} and not self._valid_checksum(checksum):
        return None
    return response

  @staticmethod
  def _valid_checksum(value: object) -> bool:
    if not isinstance(value, str) or len(value) != 64:
      return False
    try:
      int(value, 16)
    except ValueError:
      return False
    return True
