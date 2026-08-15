from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[3]
COMPOSE = ROOT / "deploy" / "mikrus" / "docker-compose.yml"


def test_mikrus_uses_only_the_light_ai_boundary_and_a_private_knowledge_url():
  compose = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
  service = compose["services"]["ai-service"]
  serialized = yaml.safe_dump(service).lower()

  assert "eisenhower-ai-boundary" in service["image"]
  assert "app.api_boundary:from_environment" in service["command"]
  assert "KNOWLEDGE_SERVICE_BASE_URL" in service["environment"]
  assert "KNOWLEDGE_SERVICE_ALLOWED_HOSTS" in service["environment"]
  for forbidden in (
    "local_model",
    "training_data",
    "evaluation_data",
    "tesseract",
    "qdrant",
    "mongodb",
    "docling",
    "onnx",
  ):
    assert forbidden not in serialized
  assert "volumes" not in service


def test_mikrus_boundary_healthcheck_uses_the_python_runtime_present_in_the_image():
  compose = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
  command = compose["services"]["ai-service"]["healthcheck"]["test"]

  assert command[:2] == ["CMD", "python"]
  assert "urllib.request" in command[-1]
  assert "curl" not in command
