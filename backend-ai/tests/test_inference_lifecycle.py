import pytest

from app.inference_lifecycle import (
  InferenceLifecycleUnauthorized,
  InferenceWakeTimeout,
  ScaleToZeroController,
)


def test_scale_to_zero_requires_operator_authorization_and_never_exposes_vllm_dev_endpoints():
  actions = []
  controller = ScaleToZeroController(
    operator_token="operator-secret",
    start=lambda: actions.append("start"),
    stop=lambda: actions.append("stop"),
    is_ready=lambda: True,
    wake_timeout_seconds=10,
  )

  with pytest.raises(InferenceLifecycleUnauthorized):
    controller.sleep("wrong-token")

  controller.sleep("operator-secret")
  assert actions == ["stop"]


def test_cold_wake_waits_for_readiness_with_a_bounded_deadline():
  actions = []
  readiness = iter([False, False, True])
  times = iter([0.0, 0.2, 0.4, 0.6])
  controller = ScaleToZeroController(
    operator_token="operator-secret",
    start=lambda: actions.append("start"),
    stop=lambda: actions.append("stop"),
    is_ready=lambda: next(readiness),
    wake_timeout_seconds=1,
    poll_interval_seconds=0,
    monotonic_clock=lambda: next(times),
    sleeper=lambda _seconds: None,
  )

  controller.wake("operator-secret")
  assert actions == ["start"]


def test_cold_wake_timeout_stops_partial_runtime_and_fails_closed():
  actions = []
  times = iter([0.0, 0.6, 1.1])
  controller = ScaleToZeroController(
    operator_token="operator-secret",
    start=lambda: actions.append("start"),
    stop=lambda: actions.append("stop"),
    is_ready=lambda: False,
    wake_timeout_seconds=1,
    poll_interval_seconds=0,
    monotonic_clock=lambda: next(times),
    sleeper=lambda _seconds: None,
  )

  with pytest.raises(InferenceWakeTimeout):
    controller.wake("operator-secret")

  assert actions == ["start", "stop"]
