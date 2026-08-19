from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


def _profile(name: str) -> dict:
  payload = yaml.safe_load((ROOT / "deploy" / "inference" / f"compose.{name}.yaml").read_text())
  return payload["services"]["inference"]


def _services(name: str) -> dict:
  payload = yaml.safe_load((ROOT / "deploy" / "inference" / f"compose.{name}.yaml").read_text())
  return payload["services"]


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
  assert amd["image"].startswith("${AMD_RESPONSE_IMAGE:?")
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


def test_amd_generation_and_reranking_share_one_exact_release_image_without_host_ports():
  payload = yaml.safe_load((ROOT / "deploy/inference/compose.amd.yaml").read_text())
  services = payload["services"]

  assert services["inference"]["image"] == (
    "${AMD_RESPONSE_IMAGE:?immutable AMD response image digest is required}"
  )
  assert services["reranker"]["image"] == services["inference"]["image"]
  for name in ("inference", "reranker"):
    assert "ports" not in services[name]
    assert services[name]["expose"] == ["8000"]

  assert services["inference"]["command"][1] == "${INFERENCE_MODEL:?INFERENCE_MODEL is provider configuration}"
  assert services["inference"]["command"][3] == "${INFERENCE_MODEL_REVISION:?INFERENCE_MODEL_REVISION is required}"
  assert "--tokenizer-revision" in services["inference"]["command"]
  assert "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e" in services["reranker"]["command"]
  assert services["inference"]["volumes"] == [
    "inference_model_cache:/root/.cache/huggingface:ro"
  ]
  assert services["reranker"]["volumes"] == [
    "reranker_model_cache:/root/.cache/huggingface:ro"
  ]
  assert payload["volumes"] == {
    "inference_model_cache": {
      "external": True,
      "name": "${INFERENCE_MODEL_CACHE_VOLUME:?inference model cache volume is required}",
    },
    "reranker_model_cache": {
      "external": True,
      "name": "${RERANKER_MODEL_CACHE_VOLUME:?reranker model cache volume is required}",
    },
  }


def test_rocm_response_dockerfile_exposes_an_exact_sha_release_target():
  dockerfile = (ROOT / "backend-ai" / "Dockerfile.response-rocm").read_text()

  assert " AS response" in dockerfile
  assert "org.opencontainers.image.revision=$RELEASE_SHA" in dockerfile
