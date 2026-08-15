from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


def test_ai_images_install_role_specific_dependencies_without_model_prefetch():
  dockerfile = (ROOT / "backend-ai" / "Dockerfile").read_text(encoding="utf-8")
  requirements = {
    name: (ROOT / "backend-ai" / f"requirements-{name}.txt").read_text(encoding="utf-8")
    for name in ("boundary", "classifier", "knowledge", "ingest")
  }

  for target in ("boundary", "classifier", "knowledge", "ingest"):
    assert f"AS {target}" in dockerfile
    assert f"requirements-{target}.txt" in dockerfile
  assert "SentenceTransformer(" not in dockerfile
  assert "torch==" not in requirements["boundary"]
  assert "sentence-transformers" not in requirements["boundary"]
  assert "docling" not in requirements["classifier"]
  assert "unstructured" not in requirements["knowledge"]
  assert "docling" in requirements["ingest"]
  assert "en_core_web_sm-3.8.0-py3-none-any.whl" in requirements["ingest"]
  assert "sha256=1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85" in requirements["ingest"]
  ingest_stage = dockerfile.split("FROM dependencies-ingest AS ingest", maxsplit=1)[1]
  assert "libgl1" in ingest_stage


def test_rocm_knowledge_image_is_dedicated_and_does_not_include_vllm_or_ingest_tools():
  dockerfile = (ROOT / "backend-ai" / "Dockerfile.rocm").read_text(encoding="utf-8")

  assert "rocm/pytorch@sha256:4449f856653602317e4101a76fce599c7fcd58ccec2e539951fce5f73083179e" in dockerfile
  assert "eisenhower.runtime.role=knowledge-rocm" in dockerfile
  assert "requirements-knowledge-rocm.txt" in dockerfile
  assert "apt-get upgrade -y" in dockerfile
  assert "vllm/vllm-openai-rocm" not in dockerfile
  assert "tesseract" not in dockerfile
  assert "poppler" not in dockerfile
  assert "pytesseract" not in dockerfile

  deploy_script = (ROOT / "deploy" / "local" / "deploy.sh").read_text(encoding="utf-8")
  assert "-f backend-ai/Dockerfile.rocm" in deploy_script


def test_rocm_response_image_is_hardened_pinned_and_built_for_both_response_roles():
  dockerfile = (ROOT / "backend-ai" / "Dockerfile.response-rocm").read_text(encoding="utf-8")
  deploy_script = (ROOT / "deploy" / "local" / "deploy.sh").read_text(encoding="utf-8")

  assert "vllm/vllm-openai-rocm@sha256:5709fafe47123becb2f5e61c32d0b97beff1a629bb40bb753c15464f69a97a18" in dockerfile
  assert "apt-get upgrade -y" in dockerfile
  assert "pip uninstall -y PyGObject" in dockerfile
  assert "python -m pip check" in dockerfile
  assert 'ENTRYPOINT ["vllm", "serve"]' in dockerfile
  assert 'VLLM_RESPONSE_IMAGE="local/eisenhower-vllm-rocm:${release_sha}"' in deploy_script
  assert 'export AMD_INFERENCE_IMAGE="$response_image_id"' in deploy_script
  assert 'export AMD_RERANKER_IMAGE="$response_image_id"' in deploy_script
  assert "-f backend-ai/Dockerfile.response-rocm" in deploy_script
  assert 'for image_ref in "$VLLM_RESPONSE_IMAGE" "$MCP_IMAGE" "$WEB_IMAGE"' in deploy_script


def test_local_compose_defaults_to_core_and_keeps_heavy_roles_explicit():
  compose = yaml.safe_load((ROOT / "deploy" / "local" / "compose.yaml").read_text())
  services = compose["services"]

  assert services["ai-service"]["image"].startswith("${AI_BOUNDARY_IMAGE")
  assert "profiles" not in services["ai-service"]
  assert "profiles" not in services["classifier-service"]
  for service in ("knowledge-service", "rag-worker", "qdrant"):
    assert {"retrieval", "response", "full"}.issubset(services[service]["profiles"])
  for service in ("n8n", "calendar-gateway"):
    assert {"automation", "full"}.issubset(services[service]["profiles"])
  for service in ("identity-db", "identity-service"):
    assert {"identity", "full"}.issubset(services[service]["profiles"])
  assert services["ai-service"]["mem_limit"]
  assert services["ai-service"]["cpus"]
  assert services["ai-service"]["pids_limit"]
  for service in ("classifier-service", "knowledge-service", "rag-worker"):
    environment = services[service]["environment"]
    assert "HF_HUB_OFFLINE=1" in environment
    assert "TRANSFORMERS_OFFLINE=1" in environment
  worker = services["rag-worker"]
  assert services["knowledge-service"]["command"] == [
    "python", "-m", "uvicorn", "app.knowledge_runtime:from_environment", "--factory",
    "--host", "0.0.0.0", "--port", "8000", "--workers", "1",
  ]
  assert worker["command"] == ["python", "-m", "app.worker_runtime"]
  assert "DOCLING_ARTIFACTS_PATH=/app/docling-artifacts" in worker["environment"]
  assert (
    "DOCLING_ARTIFACTS_MANIFEST_SHA256="
    "${DOCLING_ARTIFACTS_MANIFEST_SHA256:?approved Docling artifact manifest digest is required}"
  ) in worker["environment"]
  assert (
    "${AI_DOCLING_ARTIFACT_ROOT:?approved Docling artifact directory is required}:"
    "/app/docling-artifacts:ro"
  ) in worker["volumes"]
  assert "NUMBA_CACHE_DIR=/app/runtime/numba" in worker["environment"]
  assert "MPLCONFIGDIR=/app/runtime/matplotlib" in worker["environment"]
  assert "XDG_CACHE_HOME=/app/runtime/cache" in worker["environment"]

  deploy_script = (ROOT / "deploy" / "local" / "deploy.sh").read_text(encoding="utf-8")
  for action in ("deploy-core", "deploy-retrieval", "deploy-response", "deploy-full"):
    assert f"{action})" in deploy_script
  assert "deploy) deploy_core" in deploy_script
  assert "validate_docling_approval" in deploy_script
  assert "Docling artifact manifest digest mismatch" in deploy_script


def test_amd_vllm_lifecycle_is_private_bounded_and_opt_in():
  compose = yaml.safe_load((ROOT / "deploy" / "local" / "compose.amd.yaml").read_text())
  inference = compose["services"]["inference"]
  deploy_script = (ROOT / "deploy" / "local" / "deploy.sh").read_text(encoding="utf-8")

  assert "--enable-sleep-mode" not in inference["command"]
  assert "VLLM_SERVER_DEV_MODE" not in str(inference)
  assert inference["ports"][0].startswith("${INFERENCE_BIND_ADDRESS:-127.0.0.1}")
  assert inference["pids_limit"]
  assert inference["mem_limit"]
  assert inference["cpus"]
  assert "HF_HUB_OFFLINE=1" in inference["environment"]
  assert "TRANSFORMERS_OFFLINE=1" in inference["environment"]
  assert "HF_HUB_OFFLINE=1" in compose["services"]["reranker"]["environment"]
  assert "sleep-response" in deploy_script
  assert "wake-response" in deploy_script
  assert "/v1/models" in deploy_script
  assert "compose_response start reranker" in deploy_script
  assert "compose_response start inference" in deploy_script
  assert "compose_response up --no-deps -d reranker" in deploy_script
  assert "compose_response up --no-deps -d inference" in deploy_script
  assert compose["services"]["knowledge-service"]["image"].startswith("${AI_ROCM_IMAGE")
  assert "render" not in compose["services"]["knowledge-service"]["group_add"]
  assert "110" in compose["services"]["knowledge-service"]["group_add"]
  assert "rag-worker" not in compose["services"]
  assert 'AI_ROCM_IMAGE="local/eisenhower-ai-rocm:${release_sha}"' in deploy_script
  assert "Dockerfile.knowledge-rocm-candidate" not in deploy_script
  assert 'export AMD_INFERENCE_IMAGE="$response_image_id"' in deploy_script
  assert 'export AMD_RERANKER_IMAGE="$response_image_id"' in deploy_script


def test_response_cold_wake_serializes_reranker_before_inference():
  deploy_script = (ROOT / "deploy" / "local" / "deploy.sh").read_text(encoding="utf-8")
  wake = deploy_script.split("wake_response() {", 1)[1].split("\n}\n", 1)[0]

  assert "start reranker" in wake
  assert "wait_for_response_service reranker" in wake
  assert "start inference" in wake
  assert "wait_for_response_service inference" in wake
  assert wake.index("start reranker") < wake.index("wait_for_response_service reranker")
  assert wake.index("wait_for_response_service reranker") < wake.index("start inference")
  assert wake.index("start inference") < wake.index("wait_for_response_service inference")
