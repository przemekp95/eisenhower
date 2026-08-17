from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess

import yaml


ROOT = Path(__file__).resolve().parents[2]
COMPOSE_PATH = ROOT / "compose.yaml"
PROVIDER_STACKS = (
  ROOT / "deploy" / "inference" / "compose.amd.yaml",
  ROOT / "deploy" / "inference" / "compose.nvidia.yaml",
)
PRIVATE_SERVICES = {
  "mongodb", "qdrant", "api-service", "ai-service", "n8n",
  "prometheus", "grafana", "oauth2-proxy",
}
MANDATORY_ADMIN_SERVICES = {"n8n", "prometheus", "grafana", "oauth2-proxy"}
INFERENCE_CONTRACT = {
  "INFERENCE_BASE_URL",
  "INFERENCE_API_KEY",
  "INFERENCE_ALLOWED_HOSTS",
}


def _compose() -> dict:
  assert COMPOSE_PATH.is_file(), "compose.yaml must be the canonical application topology"
  return yaml.safe_load(COMPOSE_PATH.read_text())


def _environment_names(service: dict) -> set[str]:
  environment = service.get("environment", {})
  if isinstance(environment, dict):
    return set(environment)
  return {str(item).split("=", 1)[0] for item in environment}


def _safe_render_environment(app_env: str) -> dict[str, str]:
  text = COMPOSE_PATH.read_text()
  required = set(re.findall(r"\$\{([A-Z][A-Z0-9_]*):\?", text))
  values = {name: "contract-placeholder" for name in required}
  for name in required:
    if name.endswith("_CPU_LIMIT"):
      values[name] = "1.0"
    elif name.endswith("_MEMORY_LIMIT"):
      values[name] = "1g"
    elif name.endswith(("_PID_LIMIT", "_THREADS", "_MAX_QUEUED")):
      values[name] = "1"
    elif name.endswith("_ROOT"):
      values[name] = "/tmp/eisenhower-contract"
    elif name.endswith("_FILE"):
      values[name] = "/tmp/eisenhower-contract.json"
  values.update({
    "APP_ENV": app_env,
    "AUTH_MODE": "oidc",
    "RELEASE_SHA": "1" * 40,
    "OIDC_ISSUER": "https://identity.example.test/realms/eisenhower",
    "OIDC_AUDIENCE": "eisenhower-api",
    "OIDC_JWKS_URL": "https://identity.example.test/jwks",
    "CORS_ALLOW_ORIGINS": "https://app.example.test",
    "INFERENCE_BASE_URL": "https://inference.example.test/v1",
    "INFERENCE_API_KEY": "i" * 32,
    "INFERENCE_ALLOWED_HOSTS": "inference.example.test",
    "GATEWAY_PORT": "8443",
  })
  return {**os.environ, **values}


def _render(app_env: str) -> dict:
  result = subprocess.run(
    ["docker", "compose", "--profile", "*", "-f", str(COMPOSE_PATH), "config", "--format", "json"],
    cwd=ROOT,
    env=_safe_render_environment(app_env),
    check=True,
    capture_output=True,
    text=True,
  )
  return json.loads(result.stdout)


def _graph(rendered: dict) -> dict:
  return {
    name: {
      "depends_on": sorted(service.get("depends_on", {})),
      "networks": sorted(service.get("networks", {})),
      "profiles": sorted(service.get("profiles", [])),
    }
    for name, service in rendered["services"].items()
  }


def test_canonical_compose_has_one_ingress_and_private_internal_services():
  services = _compose()["services"]
  published = {name for name, service in services.items() if service.get("ports")}

  assert published == {"gateway"}
  assert PRIVATE_SERVICES <= set(services)
  for name in PRIVATE_SERVICES:
    assert not services[name].get("ports"), f"{name} must remain private"


def test_admin_services_are_mandatory_healthy_and_use_the_same_private_graph():
  services = _compose()["services"]

  assert MANDATORY_ADMIN_SERVICES <= set(services)
  for name in MANDATORY_ADMIN_SERVICES:
    assert not services[name].get("profiles"), f"{name} must be unconditional"
    assert not services[name].get("ports"), f"{name} must remain private"
    assert services[name].get("healthcheck"), f"{name} must be health-gated"

  gateway_dependencies = set(services["gateway"].get("depends_on", {}))
  assert MANDATORY_ADMIN_SERVICES <= gateway_dependencies


def test_application_uses_one_three_variable_inference_contract_and_external_provider_stacks():
  services = _compose()["services"]
  inference_consumers = [
    name for name, service in services.items()
    if INFERENCE_CONTRACT <= _environment_names(service)
  ]

  assert inference_consumers
  assert "inference" not in services
  for provider_path in PROVIDER_STACKS:
    provider_services = yaml.safe_load(provider_path.read_text())["services"]
    assert "inference" in provider_services
    assert not ({"web", "api-service", "ai-service", "mongodb", "qdrant", "n8n"} & set(provider_services))


def test_dev_and_prod_render_the_identical_service_graph():
  assert _graph(_render("development")) == _graph(_render("production"))
