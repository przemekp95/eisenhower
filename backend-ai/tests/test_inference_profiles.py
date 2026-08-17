from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


def _profile(name: str) -> dict:
  payload = yaml.safe_load((ROOT / "deploy" / "inference" / f"compose.{name}.yaml").read_text())
  return payload["services"]["inference"]


def test_base_compose_is_vendor_neutral_and_remote_endpoint_configurable():
  text = (ROOT / "compose.yaml").read_text()

  assert "ai-service-gpu:" not in text
  assert "driver: nvidia" not in text
  assert "vllm:" not in text
  assert "INFERENCE_BASE_URL=${INFERENCE_BASE_URL:-http://inference:8000/v1}" in text
  assert "INFERENCE_API_KEY=${INFERENCE_API_KEY:-}" in text
  assert "INFERENCE_ALLOWED_HOSTS=${INFERENCE_ALLOWED_HOSTS:-inference}" in text
  assert "INFERENCE_MODEL=" not in text


def test_nvidia_and_amd_profiles_are_opt_in_private_and_version_pinned():
  nvidia = _profile("nvidia")
  amd = _profile("amd")

  assert nvidia["image"].startswith("${NVIDIA_INFERENCE_IMAGE:?")
  assert amd["image"].startswith("${AMD_INFERENCE_IMAGE:?")
  assert nvidia["profiles"] == ["inference-nvidia"]
  assert amd["profiles"] == ["inference-amd"]
  assert "ports" not in nvidia and "ports" not in amd
  assert nvidia["expose"] == ["8000"] and amd["expose"] == ["8000"]
  assert nvidia["command"][1].startswith("${INFERENCE_MODEL:?")
  assert amd["command"][1].startswith("${INFERENCE_MODEL:?")
  assert "${INFERENCE_API_KEY:?INFERENCE_API_KEY is required}" in nvidia["command"]
  assert "${INFERENCE_API_KEY:?INFERENCE_API_KEY is required}" in amd["command"]
  assert "deploy" in nvidia
  assert amd["devices"] == ["/dev/kfd:/dev/kfd", "/dev/dri:/dev/dri"]
