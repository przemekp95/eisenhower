from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json

from app.ops.response_canary import ResponseCanaryRouter


def _write_pointer(path, *, valid_until: datetime, percent: int = 5, candidate_id: str = "answer-v1"):
  path.write_text(json.dumps({
    "schema_version": "ai-promotion-pointer-v1",
    "revision": 4,
    "previous_revision": 3,
    "phases": {
      "retrieval": {"mode": "canary", "candidate_id": "rag-v1", "canary_percent": 5},
      "generation": {"mode": "canary", "candidate_id": "llm-v1", "canary_percent": 5},
      "response": {
        "mode": "canary",
        "candidate_id": candidate_id,
        "canary_percent": percent,
        "quality_report_checksum": "a" * 64,
        "approval_checksum": "b" * 64,
        "approval_valid_until": valid_until.isoformat(),
      },
      "mag": {"mode": "disabled", "candidate_id": None, "canary_percent": 0},
    },
  }), encoding="utf-8")


def test_response_canary_is_stable_and_bounded_by_pointer_percentage(tmp_path):
  now = datetime(2026, 8, 12, 12, tzinfo=UTC)
  pointer = tmp_path / "current.json"
  _write_pointer(pointer, valid_until=now + timedelta(days=3), percent=5)
  router = ResponseCanaryRouter(pointer, candidate_id="answer-v1", now=lambda: now)

  decisions = [router.evaluate("owner-tenant", f"user-{index}") for index in range(1000)]

  assert decisions == [router.evaluate("owner-tenant", f"user-{index}") for index in range(1000)]
  assert 30 <= sum(decision.allowed for decision in decisions) <= 70
  assert {decision.reason for decision in decisions} == {None, "response_canary_not_selected"}


def test_response_canary_fails_closed_after_approval_expiry_or_pointer_mismatch(tmp_path):
  now = datetime(2026, 8, 16, 0, tzinfo=UTC)
  pointer = tmp_path / "current.json"
  _write_pointer(pointer, valid_until=now - timedelta(seconds=1))

  expired = ResponseCanaryRouter(pointer, candidate_id="answer-v1", now=lambda: now)
  mismatched = ResponseCanaryRouter(pointer, candidate_id="other", now=lambda: now)

  assert expired.evaluate("owner-tenant", "owner-user").reason == "response_approval_expired"
  assert mismatched.evaluate("owner-tenant", "owner-user").reason == "response_promotion_invalid"


def test_response_canary_fails_closed_on_unreadable_or_malformed_pointer(tmp_path):
  missing = ResponseCanaryRouter(tmp_path / "missing.json", candidate_id="answer-v1")
  malformed_path = tmp_path / "current.json"
  malformed_path.write_text("{}", encoding="utf-8")
  malformed = ResponseCanaryRouter(malformed_path, candidate_id="answer-v1")

  assert missing.evaluate("owner-tenant", "owner-user").reason == "response_promotion_unavailable"
  assert malformed.evaluate("owner-tenant", "owner-user").reason == "response_promotion_invalid"
