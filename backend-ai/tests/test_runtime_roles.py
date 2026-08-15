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

  deploy_script = (ROOT / "deploy" / "local" / "deploy.sh").read_text(encoding="utf-8")
  for action in ("deploy-core", "deploy-retrieval", "deploy-response", "deploy-full"):
    assert f"{action})" in deploy_script
  assert "deploy) deploy_core" in deploy_script


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
