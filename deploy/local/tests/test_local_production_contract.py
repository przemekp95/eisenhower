from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[3]
COMPOSE_PATH = ROOT / "deploy" / "local" / "compose.yaml"
AMD_COMPOSE_PATH = ROOT / "deploy" / "local" / "compose.amd.yaml"
ENV_PATH = ROOT / "deploy" / "local" / ".env.example"


class LocalProductionContractTest(unittest.TestCase):
  def setUp(self):
    self.compose_text = COMPOSE_PATH.read_text()
    self.compose = yaml.safe_load(self.compose_text)
    self.services = self.compose["services"]
    self.amd_compose_text = AMD_COMPOSE_PATH.read_text()
    self.amd_services = yaml.safe_load(self.amd_compose_text)["services"]

  def _service(self, name: str) -> dict:
    return self.services.get(name) or self.amd_services[name]

  def test_declares_only_real_independently_placeable_processes(self):
    self.assertEqual(
      set(self.services) | set(self.amd_services),
      {"api-service", "mongodb", "ai-service", "rag-worker", "qdrant", "n8n", "inference"},
    )
    self.assertNotIn("mcp", self.services)
    self.assertNotIn("outbox-worker", self.services)

  def test_cross_service_urls_are_configurable_with_same_host_defaults(self):
    required_defaults = {
      "api-service": [
        "MONGODB_URI=${MONGODB_URI:-mongodb://mongodb:27017/eisenhower?replicaSet=rs0}",
        "AI_SERVICE_URL=${AI_SERVICE_URL:-http://ai-service:8000}",
      ],
      "ai-service": [
        "QDRANT_URL=${QDRANT_URL:-http://qdrant:6333}",
        "INFERENCE_BASE_URL=${INFERENCE_BASE_URL:-http://inference:8000/v1}",
      ],
      "rag-worker": [
        "MONGODB_URI=${MONGODB_URI:-mongodb://mongodb:27017/eisenhower?replicaSet=rs0}",
        "QDRANT_URL=${QDRANT_URL:-http://qdrant:6333}",
      ],
      "n8n": ["EISENHOWER_INTERNAL_API_URL=${EISENHOWER_INTERNAL_API_URL:-http://api-service:3001}"],
    }
    for service_name, entries in required_defaults.items():
      environment = self._service(service_name)["environment"]
      for entry in entries:
        self.assertIn(entry, environment)

  def test_every_host_port_defaults_to_loopback_and_can_bind_a_private_address(self):
    for name, service in (self.services | self.amd_services).items():
      for published_port in service.get("ports", []):
        self.assertIn("_BIND_ADDRESS:-127.0.0.1", published_port, name)
        self.assertNotIn("0.0.0.0", published_port, name)

  def test_images_are_versioned_and_accept_digest_overrides(self):
    expected_image_inputs = {
      "api-service": "API_IMAGE",
      "mongodb": "MONGODB_IMAGE",
      "ai-service": "AI_IMAGE",
      "rag-worker": "AI_IMAGE",
      "qdrant": "QDRANT_IMAGE",
      "n8n": "N8N_IMAGE",
      "inference": "AMD_INFERENCE_IMAGE",
    }
    for name, variable in expected_image_inputs.items():
      image = self._service(name)["image"]
      self.assertIn(f"${{{variable}", image, name)
      self.assertNotIn(":latest", image, name)

  def test_amd_inference_is_opt_in_and_has_no_fake_readiness_claim(self):
    inference = self.amd_services["inference"]
    self.assertEqual(inference["profiles"], ["inference-amd"])
    self.assertEqual(inference["devices"], ["/dev/kfd:/dev/kfd", "/dev/dri:/dev/dri"])
    self.assertNotIn("healthcheck", inference)
    self.assertIn("INFERENCE_MODEL is required", self.amd_compose_text)
    self.assertIn("INFERENCE_API_KEY is required", self.amd_compose_text)

  def test_application_images_receive_required_production_identity_and_audit_config(self):
    for name in ("api-service", "ai-service"):
      environment = self.services[name]["environment"]
      self.assertIn("RELEASE_SHA=${RELEASE_SHA:?RELEASE_SHA is required}", environment)
      self.assertIn("AUDIT_HMAC_KEY=${AUDIT_HMAC_KEY:?AUDIT_HMAC_KEY is required}", environment)

    ai_environment = self.services["ai-service"]["environment"]
    self.assertIn("LOCAL_MODEL_REQUIRE_EVALUATION=true", ai_environment)
    self.assertIn(
      "LOCAL_MODEL_APPROVED_EVALUATION_SHA256=${LOCAL_MODEL_APPROVED_EVALUATION_SHA256:?approved evaluation digest is required}",
      ai_environment,
    )
    self.assertTrue(any(volume.endswith(":/app/evaluation/production.json:ro") for volume in self.services["ai-service"]["volumes"]))
    self.assertIn(
      "CALENDAR_INTERNAL_HMAC_KEY=${CALENDAR_INTERNAL_HMAC_KEY:?CALENDAR_INTERNAL_HMAC_KEY is required}",
      self.services["api-service"]["environment"],
    )
    self.assertIn(
      "CALENDAR_INTERNAL_HMAC_KEY=${CALENDAR_INTERNAL_HMAC_KEY:?CALENDAR_INTERNAL_HMAC_KEY is required}",
      self.services["n8n"]["environment"],
    )
    self.assertIn("NODE_FUNCTION_ALLOW_BUILTIN=crypto", self.services["n8n"]["environment"])

  def test_mongodb_supports_transactional_outbox_without_missing_host_mounts(self):
    mongodb = self.services["mongodb"]
    self.assertIn("--replSet", mongodb["command"])
    self.assertIn("rs0", mongodb["command"])
    self.assertIn("rs.initiate", str(mongodb["healthcheck"]["test"]))
    for volume in mongodb.get("volumes", []):
      source = volume.split(":", 1)[0]
      if source.startswith("."):
        self.assertTrue((COMPOSE_PATH.parent / source).resolve().exists(), volume)

  def test_example_environment_has_no_operational_secrets(self):
    env_text = ENV_PATH.read_text()
    self.assertIn("API_IMAGE=", env_text)
    self.assertIn("AI_IMAGE=", env_text)
    self.assertIn("EISENHOWER_API_TOKEN=", env_text)
    self.assertNotIn("change-me", env_text.lower())


if __name__ == "__main__":
  unittest.main()
