from pathlib import Path
import json
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[3]
COMPOSE_PATH = ROOT / "deploy" / "local" / "compose.yaml"
AMD_COMPOSE_PATH = ROOT / "deploy" / "local" / "compose.amd.yaml"
ENV_PATH = ROOT / "deploy" / "local" / ".env.example"
GATEWAY_CONFIG_PATH = ROOT / "deploy" / "local" / "calendar-gateway.conf.template"
ACCESS_GATEWAY_CONFIG_PATH = ROOT / "deploy" / "local" / "access-gateway.conf.template"
DEPLOY_SCRIPT_PATH = ROOT / "deploy" / "local" / "deploy.sh"
KEYCLOAK_REALM_PATH = ROOT / "deploy" / "local" / "identity" / "eisenhower-realm.json"
KEYCLOAK_USER_PROFILE_PATH = (
  ROOT / "deploy" / "local" / "identity" / "eisenhower-user-profile.json"
)
KEYCLOAK_E2E_REALM_PATH = (
  ROOT / "deploy" / "local" / "identity" / "e2e" / "eisenhower-e2e-realm.json"
)


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
      {
        "api-service", "mongodb", "ai-service", "classifier-service", "rag-worker", "qdrant", "n8n",
        "knowledge-service",
        "calendar-gateway", "audit-volume-init", "identity-db", "identity-service",
        "mcp-service", "access-gateway", "web", "inference", "reranker",
      },
    )
    self.assertNotIn("outbox-worker", self.services)

  def test_cross_service_urls_are_configurable_with_same_host_defaults(self):
    required_defaults = {
      "api-service": [
        "MONGODB_URI=${MONGODB_URI:-mongodb://mongodb:27017/eisenhower?replicaSet=rs0}",
        "AI_SERVICE_URL=${AI_SERVICE_URL:-http://ai-service:8000}",
      ],
      "ai-service": [
        "CLASSIFIER_SERVICE_URL=http://classifier-service:8000",
        "KNOWLEDGE_SERVICE_URL=${KNOWLEDGE_SERVICE_URL:-http://classifier-service:8000}",
      ],
      "knowledge-service": [
        "QDRANT_URL=${QDRANT_URL:-http://qdrant:6333}",
        "INFERENCE_BASE_URL=${INFERENCE_BASE_URL:-http://inference:8000/v1}",
        "RAG_RETRIEVAL_STRATEGY=${RAG_RETRIEVAL_STRATEGY:-hybrid-bge-v1}",
        "RERANKER_BASE_URL=${RERANKER_BASE_URL:-http://reranker:8000}",
        "RAG_RESPONSE_PROMOTION_POINTER_PATH=/app/promotion/current.json",
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
        if name in {"calendar-gateway", "access-gateway"}:
          self.assertTrue(published_port.startswith("127.0.0.1:"), name)
          self.assertNotIn("BIND_ADDRESS", published_port, name)
          continue
        self.assertIn("_BIND_ADDRESS:-127.0.0.1", published_port, name)
        self.assertNotIn("0.0.0.0", published_port, name)

  def test_images_are_versioned_and_accept_digest_overrides(self):
    expected_image_inputs = {
      "api-service": "API_IMAGE",
      "mongodb": "MONGODB_IMAGE",
      "ai-service": "AI_BOUNDARY_IMAGE",
      "classifier-service": "AI_CLASSIFIER_IMAGE",
      "knowledge-service": "AI_KNOWLEDGE_IMAGE",
      "rag-worker": "AI_INGEST_IMAGE",
      "qdrant": "QDRANT_IMAGE",
      "n8n": "N8N_IMAGE",
      "calendar-gateway": "CALENDAR_GATEWAY_IMAGE",
      "identity-db": "IDENTITY_DB_IMAGE",
      "identity-service": "KEYCLOAK_IMAGE",
      "mcp-service": "MCP_IMAGE",
      "access-gateway": "ACCESS_GATEWAY_IMAGE",
      "web": "WEB_IMAGE",
      "audit-volume-init": "VOLUME_INIT_IMAGE",
      "inference": "AMD_INFERENCE_IMAGE",
      "reranker": "AMD_RERANKER_IMAGE",
    }
    for name, variable in expected_image_inputs.items():
      image = self._service(name)["image"]
      self.assertIn(f"${{{variable}", image, name)
    self.assertNotIn(":latest", image, name)

  def test_reranker_shares_the_gpu_with_generation(self):
    command = self.amd_services["reranker"]["command"]
    option_index = command.index("--gpu-memory-utilization")
    self.assertEqual(command[option_index + 1], "0.10")

  def test_web_is_deployed_behind_the_private_access_gateway(self):
    web = self.services["web"]
    self.assertNotIn("ports", web)
    self.assertIn("VITE_API_URL=/api", web["environment"])
    self.assertIn("VITE_AI_API_URL=/ai", web["environment"])
    self.assertIn("VITE_OIDC_ISSUER=${OIDC_ISSUER:?OIDC_ISSUER is required}", web["environment"])
    self.assertIn("VITE_OIDC_CLIENT_ID=eisenhower-web", web["environment"])
    self.assertIn(
      "VITE_OIDC_REDIRECT_URI=${EISENHOWER_OIDC_REDIRECT_URI:?EISENHOWER_OIDC_REDIRECT_URI is required}",
      web["environment"],
    )
    self.assertIn("healthcheck", web)

    gateway = self.services["access-gateway"]
    self.assertIn("WEB_UPSTREAM=${ACCESS_GATEWAY_WEB_UPSTREAM:-web:3000}", gateway["environment"])
    self.assertIn(
      "KNOWLEDGE_UPSTREAM=${ACCESS_GATEWAY_KNOWLEDGE_UPSTREAM:-knowledge-service:8000}",
      gateway["environment"],
    )
    self.assertEqual(gateway["depends_on"]["web"]["condition"], "service_healthy")
    config = ACCESS_GATEWAY_CONFIG_PATH.read_text()
    self.assertIn("set $web_upstream ${WEB_UPSTREAM};", config)
    self.assertIn("proxy_pass http://$web_upstream;", config)
    self.assertNotIn("location / { return 404; }", config)
    self.assertIn("location = /ai/v2/knowledge/answer", config)
    self.assertIn("proxy_pass http://$knowledge_upstream/v2/knowledge/answer;", config)

  def test_knowledge_runtime_uses_the_immutable_candidate_prompt(self):
    environment = self.services["knowledge-service"]["environment"]
    self.assertIn("PROMPT_VERSION=${PROMPT_VERSION:-1.2.0}", environment)
    self.assertIn("KNOWLEDGE_PROMPT_VERSION=${KNOWLEDGE_PROMPT_VERSION:-1.0.0}", environment)
    self.assertEqual(self.services["knowledge-service"]["healthcheck"]["start_period"], "600s")

  def test_local_deploy_script_enforces_clean_exact_sha_and_records_rollback(self):
    script = DEPLOY_SCRIPT_PATH.read_text()
    self.assertIn('git diff --quiet', script)
    self.assertIn('git diff --cached --quiet', script)
    self.assertIn('release_sha="$(git rev-parse HEAD)"', script)
    self.assertIn('API_IMAGE="local/eisenhower-api:${release_sha}"', script)
    self.assertIn('AI_BOUNDARY_IMAGE="local/eisenhower-ai-boundary:${release_sha}"', script)
    self.assertIn('AI_CLASSIFIER_IMAGE="local/eisenhower-ai-classifier:${release_sha}"', script)
    self.assertIn('AI_KNOWLEDGE_IMAGE="local/eisenhower-ai-knowledge:${release_sha}"', script)
    self.assertIn('AI_INGEST_IMAGE="local/eisenhower-ai-ingest:${release_sha}"', script)
    self.assertIn('AI_ROCM_IMAGE="local/eisenhower-ai-rocm:${release_sha}"', script)
    self.assertIn('MCP_IMAGE="local/eisenhower-mcp:${release_sha}"', script)
    self.assertIn('WEB_IMAGE="local/eisenhower-web:${release_sha}"', script)
    self.assertIn('docker image inspect', script)
    self.assertIn('deploy-response)', script)
    self.assertIn('compose up --no-deps -d --wait inference reranker', script)
    self.assertIn('compose up --no-deps -d --wait knowledge-service', script)
    self.assertIn('compose_base up --no-deps audit-volume-init', script)
    self.assertNotIn('compose_base up -d --wait mongodb qdrant audit-volume-init', script)
    self.assertIn('compose_base up -d --wait mongodb qdrant identity-db identity-service n8n', script)
    self.assertIn('compose_full up --no-deps -d --wait ai-service classifier-service api-service web mcp-service', script)
    self.assertIn('compose_full up --no-deps -d --wait access-gateway calendar-gateway', script)
    self.assertIn('validate_response_inputs', script)
    self.assertIn('validate_classifier_approval', script)
    self.assertIn('LOCAL_MODEL_OWNER_APPROVAL_BYPASS=true', script)
    self.assertIn('rollback.env', script)
    self.assertIn('docker compose', script)
    self.assertIn('config --quiet', script)

  def test_first_role_split_rollback_preserves_the_legacy_monolith_topology(self):
    script = DEPLOY_SCRIPT_PATH.read_text()

    self.assertIn('ROLLBACK_LAYOUT=legacy_monolith', script)
    self.assertIn('rollback.legacy.compose.yaml', script)
    self.assertIn('rollback.legacy.compose.amd.yaml', script)
    self.assertIn('ROLLBACK_LEGACY_COMPOSE_SHA256', script)
    self.assertIn('compose_legacy()', script)
    self.assertIn('AI_IMAGE="${ROLLBACK_AI_SERVICE_IMAGE_ID:', script)
    self.assertIn('Legacy rollback Compose digest mismatch', script)
    self.assertLess(
      script.index('case "${ROLLBACK_LAYOUT:-roles}" in'),
      script.index('missing classifier rollback image'),
    )

  def test_amd_inference_is_opt_in_and_uses_the_pinned_rocm_model_contract(self):
    inference = self.amd_services["inference"]
    self.assertEqual(inference["profiles"], ["inference-amd"])
    self.assertEqual(inference["devices"], ["/dev/kfd:/dev/kfd", "/dev/dri:/dev/dri"])
    self.assertIn("healthcheck", inference)
    self.assertIn("INFERENCE_MODEL is required", self.amd_compose_text)
    self.assertIn("INFERENCE_MODEL_REVISION is required", self.amd_compose_text)
    self.assertIn("INFERENCE_API_KEY is required", self.amd_compose_text)
    self.assertIn("--dtype", inference["command"])
    self.assertIn("bfloat16", inference["command"])
    self.assertIn("--max-num-seqs", inference["command"])
    self.assertIn("model_cache:/root/.cache/huggingface", inference["volumes"])

  def test_amd_retrieval_profile_runs_pinned_bge_m3_without_enabling_generation(self):
    ai = self.amd_services["knowledge-service"]
    classifier = self.services["classifier-service"]
    worker = self.services["rag-worker"]
    self.assertEqual(ai["profiles"], ["retrieval-amd", "response-amd"])
    self.assertEqual(worker["profiles"], ["retrieval", "response", "full"])
    self.assertIn("/dev/kfd:/dev/kfd", ai["devices"])
    self.assertIn("/dev/dri:/dev/dri", ai["devices"])
    self.assertNotIn("devices", worker)
    for service in (ai, worker):
      self.assertIn("RAG_EMBEDDING_MODEL_NAME=BAAI/bge-m3", service["environment"])
      self.assertIn(
        "RAG_EMBEDDING_MODEL_REVISION=5617a9f61b028005a4858fdac845db406aefb181",
        service["environment"],
      )
      self.assertIn("EMBEDDING_VERSION=bge-m3-v1", service["environment"])
    self.assertIn("RAG_GENERATION_ENABLED=${RAG_GENERATION_ENABLED:-false}", self.services["knowledge-service"]["environment"])
    self.assertIn("RAG_RESPONSE_ENABLED=${RAG_RESPONSE_ENABLED:-false}", self.services["knowledge-service"]["environment"])
    self.assertIn("RAG_GENERATION_ENABLED=false", classifier["environment"])
    self.assertIn("RAG_RESPONSE_ENABLED=false", classifier["environment"])
    self.assertIn("RAG_RESPONSE_PROMOTION_POINTER_PATH=/app/promotion/current.json", self.services["knowledge-service"]["environment"])
    self.assertIn("${AI_PROMOTION_ROOT:-./.runtime/promotion}:/app/promotion:ro", self.services["knowledge-service"]["volumes"])
    rocm_dockerfile = (ROOT / "backend-ai" / "Dockerfile.rocm").read_text(encoding="utf-8")
    rocm_requirements = (ROOT / "backend-ai" / "requirements-knowledge-rocm.txt").read_text(encoding="utf-8")
    self.assertIn("ENTRYPOINT []", rocm_dockerfile)
    self.assertIn("grpcio==1.78.0", rocm_requirements)
    self.assertIn("protobuf>=6.31.1,<7", rocm_requirements)
    self.assertIn("vllm/vllm-openai-rocm", rocm_dockerfile)

  def test_amd_reranker_is_a_separate_pinned_bounded_private_service(self):
    reranker = self.amd_services["reranker"]
    self.assertEqual(reranker["profiles"], ["reranker-amd"])
    self.assertEqual(reranker["devices"], ["/dev/kfd:/dev/kfd", "/dev/dri:/dev/dri"])
    self.assertIn("healthcheck", reranker)
    self.assertIn("--runner", reranker["command"])
    self.assertIn("pooling", reranker["command"])
    self.assertNotIn("--task", reranker["command"])
    self.assertIn("--max-model-len", reranker["command"])
    self.assertIn("192", reranker["command"])
    self.assertIn("953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e", reranker["command"])
    self.assertIn("--no-enable-log-requests", reranker["command"])
    self.assertNotIn("--api-key", reranker["command"])
    self.assertIn(
      "VLLM_API_KEY=${RERANKER_API_KEY:?RERANKER_API_KEY is required}",
      reranker["environment"],
    )
    self.assertTrue(any(
      "RERANKER_MODEL_CACHE" in volume and volume.endswith(":/root/.cache/huggingface")
      for volume in reranker["volumes"]
    ))
    self.assertIn("RERANKER_API_KEY is required", self.amd_compose_text)

  def test_application_images_receive_required_production_identity_and_audit_config(self):
    for name in ("api-service", "ai-service"):
      environment = self.services[name]["environment"]
      self.assertIn("RELEASE_SHA=${RELEASE_SHA:?RELEASE_SHA is required}", environment)
      self.assertIn("AUDIT_HMAC_KEY=${AUDIT_HMAC_KEY:?AUDIT_HMAC_KEY is required}", environment)

    ai_environment = self.services["classifier-service"]["environment"]
    self.assertEqual(self.services["ai-service"]["group_add"], ["1001"])
    self.assertEqual(
      self.services["audit-volume-init"]["command"],
      [
        "sh",
        "-c",
        "chown 1001:1001 /audit && chmod 0770 /audit && "
        "find /audit -maxdepth 1 -type f -name 'audit.sqlite3*' "
        "-exec chown 1000:1001 {} + -exec chmod 0600 {} +",
      ],
    )
    self.assertIn(
      "INTERNAL_ALLOWED_TENANTS=${INTERNAL_ALLOWED_TENANTS:?INTERNAL_ALLOWED_TENANTS is required}",
      ai_environment,
    )
    self.assertIn("LOCAL_MODEL_REQUIRE_EVALUATION=true", ai_environment)
    self.assertIn(
      "LOCAL_MODEL_OWNER_APPROVAL_BYPASS=${LOCAL_MODEL_OWNER_APPROVAL_BYPASS:-false}",
      ai_environment,
    )
    self.assertIn(
      "LOCAL_MODEL_OWNER_APPROVAL_VALID_UNTIL=${LOCAL_MODEL_OWNER_APPROVAL_VALID_UNTIL:-}",
      ai_environment,
    )
    self.assertIn(
      "LOCAL_MODEL_APPROVED_EVALUATION_SHA256=${LOCAL_MODEL_APPROVED_EVALUATION_SHA256:?approved evaluation digest is required}",
      ai_environment,
    )
    self.assertTrue(any(volume.endswith(":/app/evaluation/production.json:ro") for volume in self.services["classifier-service"]["volumes"]))
    self.assertIn(
      "CALENDAR_INTERNAL_HMAC_KEY=${CALENDAR_INTERNAL_HMAC_KEY:?CALENDAR_INTERNAL_HMAC_KEY is required}",
      self.services["api-service"]["environment"],
    )
    self.assertIn(
      "CALENDAR_INTERNAL_HMAC_KEY=${CALENDAR_INTERNAL_HMAC_KEY:?CALENDAR_INTERNAL_HMAC_KEY is required}",
      self.services["n8n"]["environment"],
    )
    self.assertIn("N8N_BLOCK_ENV_ACCESS_IN_NODE=false", self.services["n8n"]["environment"])
    self.assertIn("NODE_FUNCTION_ALLOW_BUILTIN=crypto", self.services["n8n"]["environment"])

  def test_calendar_gateway_is_loopback_only_and_routes_exactly_two_public_requests(self):
    gateway = self.services["calendar-gateway"]
    self.assertEqual(
      gateway["ports"],
      ["127.0.0.1:${CALENDAR_GATEWAY_BIND_PORT:-8787}:8080"],
    )
    self.assertIn(
      "./calendar-gateway.conf.template:/etc/nginx/templates/default.conf.template:ro",
      gateway["volumes"],
    )
    config = GATEWAY_CONFIG_PATH.read_text()
    self.assertIn("location = /eisenhower/google-calendar/webhook", config)
    self.assertIn("proxy_pass http://${N8N_UPSTREAM}/webhook/eisenhower-google-calendar;", config)
    self.assertIn("location = /eisenhower/google-calendar/oauth/callback", config)
    self.assertIn("proxy_pass http://${API_UPSTREAM}/calendar/oauth/callback;", config)
    self.assertIn("if ($request_method != POST) { return 404; }", config)
    self.assertIn("if ($request_method != GET) { return 404; }", config)
    self.assertIn("location /", config)
    self.assertIn("return 404;", config)
    self.assertIn("client_max_body_size", config)
    self.assertIn("proxy_connect_timeout", config)
    self.assertIn("proxy_read_timeout", config)
    self.assertIn("access_log off;", config)
    self.assertNotIn("$request_uri", config)
    self.assertNotIn("$http_authorization", config)

  def test_google_oauth_secrets_live_only_in_node_and_n8n_has_no_user_google_identity(self):
    api_environment = self.services["api-service"]["environment"]
    n8n_environment = self.services["n8n"]["environment"]
    for name in (
      "GOOGLE_CALENDAR_OAUTH_CLIENT_ID",
      "GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET",
      "GOOGLE_CALENDAR_OAUTH_CALLBACK_URL",
      "GOOGLE_CALENDAR_OAUTH_ENCRYPTION_KEY",
      "GOOGLE_CALENDAR_WATCH_CALLBACK_URLS",
    ):
      self.assertTrue(any(entry.startswith(f"{name}=") for entry in api_environment), name)
      self.assertFalse(any(entry.startswith(f"{name}=") for entry in n8n_environment), name)
    for name in (
      "CALENDAR_TENANT_ID",
      "CALENDAR_OWNER_ID",
      "GOOGLE_CALENDAR_ID",
    ):
      self.assertFalse(any(entry.startswith(f"{name}=") for entry in n8n_environment), name)
    self.assertTrue(any(entry.startswith("GOOGLE_CALENDAR_WEBHOOK_URL=") for entry in n8n_environment))

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
    self.assertIn("AI_BOUNDARY_IMAGE=", env_text)
    self.assertIn("AI_CLASSIFIER_IMAGE=", env_text)
    self.assertIn("AI_KNOWLEDGE_IMAGE=", env_text)
    self.assertIn("AI_INGEST_IMAGE=", env_text)
    self.assertIn("EISENHOWER_API_TOKEN=", env_text)
    self.assertIn("AUTH_MODE=oidc", env_text)
    self.assertIn("OIDC_ISSUER=https://identity.example.invalid/realms/eisenhower", env_text)
    self.assertIn("OIDC_AUDIENCE=eisenhower-api", env_text)
    self.assertIn(
      "OIDC_JWKS_URL=https://identity.example.invalid/realms/eisenhower/protocol/openid-connect/certs",
      env_text,
    )
    self.assertNotIn("change-me", env_text.lower())

  def test_keycloak_realm_issues_the_exact_multi_user_api_claim_contract(self):
    realm = json.loads(KEYCLOAK_REALM_PATH.read_text())
    self.assertEqual(realm["realm"], "eisenhower")
    self.assertTrue(realm["enabled"])
    self.assertFalse(realm["registrationAllowed"])

    clients = {item["clientId"]: item for item in realm["clients"]}
    api = clients["eisenhower-api"]
    self.assertTrue(api["bearerOnly"])
    self.assertFalse(api["publicClient"])
    self.assertFalse(api["standardFlowEnabled"])
    self.assertFalse(api["directAccessGrantsEnabled"])
    web = clients["eisenhower-web"]
    self.assertTrue(web["publicClient"])
    self.assertTrue(web["standardFlowEnabled"])
    self.assertFalse(web["directAccessGrantsEnabled"])
    self.assertEqual(web["attributes"]["pkce.code.challenge.method"], "S256")
    self.assertEqual(web["redirectUris"], ["${EISENHOWER_OIDC_REDIRECT_URI}"])
    self.assertEqual(web["webOrigins"], ["${EISENHOWER_OIDC_WEB_ORIGIN}"])

    claims_scope = next(
      item for item in realm["clientScopes"] if item["name"] == "eisenhower-claims"
    )
    mappers = {mapper["name"]: mapper for mapper in claims_scope["protocolMappers"]}
    self.assertEqual(
      set(mappers),
      {"subject", "tenant-id", "project-ids", "realm-roles"},
    )
    self.assertEqual(mappers["subject"]["protocolMapper"], "oidc-sub-mapper")
    self.assertEqual(mappers["tenant-id"]["config"]["claim.name"], "tenant_id")
    self.assertEqual(mappers["project-ids"]["config"]["claim.name"], "project_ids")
    self.assertEqual(mappers["project-ids"]["config"]["multivalued"], "true")
    self.assertEqual(mappers["realm-roles"]["config"]["claim.name"], "roles")
    self.assertEqual(mappers["realm-roles"]["config"]["multivalued"], "true")

    required_scopes = {
      "eisenhower-claims", "tasks:read", "tasks:write", "calendar:read",
      "calendar:write", "knowledge:read", "ai:analyze",
    }
    self.assertTrue(required_scopes <= set(web["defaultClientScopes"]))
    self.assertTrue(required_scopes - {"eisenhower-claims"} <= {
      scope["name"] for scope in realm["clientScopes"]
      if scope.get("attributes", {}).get("include.in.token.scope") == "true"
    })

  def test_keycloak_mcp_uses_preregistered_pkce_and_confidential_exchange(self):
    realm_text = KEYCLOAK_REALM_PATH.read_text()
    realm = json.loads(realm_text)
    self.assertNotIn("users", realm)
    self.assertTrue(all(not client["directAccessGrantsEnabled"] for client in realm["clients"]))
    clients = {item["clientId"]: item for item in realm["clients"]}
    mcp = clients["eisenhower-mcp-client"]
    self.assertTrue(mcp["publicClient"])
    self.assertEqual(mcp["attributes"]["pkce.code.challenge.method"], "S256")
    self.assertEqual(mcp["redirectUris"], ["${EISENHOWER_MCP_REDIRECT_URI}"])
    self.assertIn("mcp:tools", mcp["defaultClientScopes"])
    exchange = clients["eisenhower-mcp-exchange"]
    self.assertFalse(exchange["publicClient"])
    self.assertEqual(exchange["clientAuthenticatorType"], "client-secret")
    self.assertEqual(exchange["secret"], "${EISENHOWER_MCP_CLIENT_SECRET}")
    self.assertEqual(exchange["attributes"]["standard.token.exchange.enabled"], "true")
    self.assertIn("api-target", exchange["defaultClientScopes"])
    self.assertNotIn("mcp:tools", exchange["defaultClientScopes"])

    scopes = {item["name"]: item for item in realm["clientScopes"]}
    mcp_mappers = {
      item["name"]: item for item in scopes["mcp:tools"]["protocolMappers"]
    }
    self.assertEqual(
      mcp_mappers["mcp-resource-audience"]["config"]["included.custom.audience"],
      "${OIDC_MCP_RESOURCE_URL}",
    )
    self.assertEqual(
      mcp_mappers["mcp-exchange-audience"]["config"]["included.client.audience"],
      "eisenhower-mcp-exchange",
    )
    api_mapper = scopes["api-target"]["protocolMappers"][0]
    self.assertEqual(api_mapper["config"]["included.client.audience"], "eisenhower-api")
    self.assertNotIn("clientPolicies", realm)

  def test_keycloak_e2e_subjects_are_stable_separate_and_have_no_checked_in_secret(self):
    realm_text = KEYCLOAK_E2E_REALM_PATH.read_text()
    realm = json.loads(realm_text)
    self.assertEqual(realm["realm"], "eisenhower-e2e")
    users = {user["username"]: user for user in realm["users"]}
    self.assertEqual(set(users), {"e2e-user-a", "e2e-user-b"})
    self.assertNotEqual(users["e2e-user-a"]["id"], users["e2e-user-b"]["id"])
    self.assertEqual(users["e2e-user-a"]["attributes"]["tenant_id"], ["local-e2e"])
    self.assertEqual(users["e2e-user-b"]["attributes"]["tenant_id"], ["local-e2e"])
    self.assertEqual(users["e2e-user-a"]["attributes"]["project_ids"], ["project-a"])
    self.assertEqual(users["e2e-user-b"]["attributes"]["project_ids"], ["project-b"])
    for username, variable in (
      ("e2e-user-a", "EISENHOWER_E2E_USER_A_PASSWORD"),
      ("e2e-user-b", "EISENHOWER_E2E_USER_B_PASSWORD"),
    ):
      self.assertEqual(users[username]["realmRoles"], ["user"])
      self.assertEqual(users[username]["credentials"], [{
        "type": "password", "value": "${" + variable + "}", "temporary": False,
      }])
    clients = {item["clientId"]: item for item in realm["clients"]}
    api = clients["eisenhower-api"]
    self.assertTrue(api["bearerOnly"])
    client = clients["eisenhower-e2e"]
    self.assertTrue(client["directAccessGrantsEnabled"])
    self.assertTrue({
      "tasks:read", "tasks:write", "calendar:read", "calendar:write",
      "knowledge:read", "ai:analyze",
    } <= set(client["defaultClientScopes"]))
    mcp = clients["eisenhower-e2e-mcp"]
    self.assertTrue(mcp["directAccessGrantsEnabled"])
    self.assertIn("mcp:tools", mcp["defaultClientScopes"])
    exchange = clients["eisenhower-e2e-mcp-exchange"]
    self.assertEqual(exchange["secret"], "${EISENHOWER_MCP_CLIENT_SECRET}")
    self.assertEqual(exchange["attributes"]["standard.token.exchange.enabled"], "true")
    self.assertIn("api-target", exchange["defaultClientScopes"])
    self.assertNotIn("clientSecret", realm_text)

  def test_oidc_and_remote_mcp_are_fail_closed_in_the_production_topology(self):
    for name in ("api-service", "ai-service"):
      environment = self.services[name]["environment"]
      self.assertIn("AUTH_MODE=oidc", environment)
      self.assertNotIn("AUTH_MODE=${AUTH_MODE:-static}", environment)
      self.assertTrue(any(item.startswith("OIDC_ISSUER=${OIDC_ISSUER:?") for item in environment))
      self.assertTrue(any(item.startswith("OIDC_AUDIENCE=${OIDC_AUDIENCE:?") for item in environment))

    identity = self.services["identity-service"]
    self.assertEqual(identity["image"], "${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.7.0}")
    self.assertNotIn("ports", identity)
    self.assertEqual(
      identity["volumes"],
      [
        "./identity/eisenhower-realm.json:/opt/keycloak/data/import/eisenhower-realm.json:ro",
        "./identity/eisenhower-user-profile.json:/opt/keycloak/conf/eisenhower-user-profile.json:ro",
      ],
    )
    self.assertNotIn("e2e", str(identity))
    self.assertIn("JAVA_OPTS_KC_HEAP=-XX:MaxRAMPercentage=65", identity["environment"])

    mcp = self.services["mcp-service"]
    self.assertNotIn("ports", mcp)
    self.assertIn("MCP_TRANSPORT=streamable-http", mcp["environment"])
    self.assertIn("MCP_BEHIND_TRUSTED_PROXY=true", mcp["environment"])
    self.assertIn(
      "MCP_OIDC_CLIENT_SECRET=${EISENHOWER_MCP_CLIENT_SECRET:?EISENHOWER_MCP_CLIENT_SECRET is required}",
      mcp["environment"],
    )
    self.assertFalse(any(item.startswith("EISENHOWER_API_TOKEN=") for item in mcp["environment"]))

  def test_access_gateway_is_the_only_remote_identity_and_mcp_ingress(self):
    gateway = self.services["access-gateway"]
    self.assertEqual(gateway["ports"], ["127.0.0.1:${ACCESS_GATEWAY_BIND_PORT:-8790}:8080"])
    self.assertIn(
      "./access-gateway.conf.template:/etc/nginx/templates/default.conf.template:ro",
      gateway["volumes"],
    )
    config = ACCESS_GATEWAY_CONFIG_PATH.read_text()
    self.assertIn("map_hash_bucket_size 128;", config)
    self.assertIn("resolver 127.0.0.11 valid=10s ipv6=off;", config)
    for upstream in ("identity", "mcp", "api", "ai"):
      self.assertIn(f"set ${upstream}_upstream ${{{upstream.upper()}_UPSTREAM}};", config)
    self.assertIn("limit_req_zone", config)
    self.assertIn("client_max_body_size", config)
    self.assertIn("if ($host != \"${ACCESS_GATEWAY_HOST}\")", config)
    self.assertIn("if ($origin_allowed = 0)", config)
    self.assertIn('map "$uri|$http_origin" $keycloak_form_origin_allowed', config)
    self.assertIn(
      "~^/identity/realms/eisenhower/login-actions/.*\\|null$ 1;",
      config,
    )
    self.assertNotIn('map $http_origin $origin_allowed', config)
    self.assertIn("location /identity/", config)
    self.assertIn("location = /mcp", config)
    self.assertIn("location = /.well-known/oauth-protected-resource/mcp", config)
    self.assertIn("location /api/", config)
    self.assertIn("location /ai/", config)
    self.assertIn("access_log off;", config)
    self.assertNotIn("$http_authorization", config)

  def test_identity_profile_declares_non_user_editable_tenant_boundaries(self):
    profile = json.loads(KEYCLOAK_USER_PROFILE_PATH.read_text())
    attributes = {item["name"]: item for item in profile["attributes"]}
    self.assertEqual(attributes["tenant_id"]["permissions"]["edit"], ["admin"])
    self.assertEqual(attributes["project_ids"]["permissions"]["edit"], ["admin"])
    self.assertFalse(attributes["tenant_id"]["multivalued"])
    self.assertTrue(attributes["project_ids"]["multivalued"])
    deploy_script = DEPLOY_SCRIPT_PATH.read_text()
    self.assertIn("configure_identity_profile", deploy_script)
    self.assertIn("-e KC_BOOTSTRAP_ADMIN_USERNAME", deploy_script)
    self.assertIn("-e KC_BOOTSTRAP_ADMIN_PASSWORD", deploy_script)
    self.assertIn(
      "http://127.0.0.1:8080/identity/admin/realms/eisenhower/users/profile",
      deploy_script,
    )
    self.assertNotIn('update users/profile \\\n+      --realm eisenhower', deploy_script)
    self.assertIn("/admin/realms/eisenhower/users/profile", deploy_script)
    self.assertIn('test "$attempt" -lt 30', deploy_script)
    self.assertIn("Keycloak Admin API did not become ready", deploy_script)

  def test_rag_worker_health_uses_durable_heartbeat_instead_of_http(self):
    healthcheck = self.services["rag-worker"]["healthcheck"]
    command = " ".join(healthcheck["test"])
    self.assertIn("latest_worker_heartbeat_age_seconds", command)
    self.assertNotIn("/health/", command)
    self.assertEqual(healthcheck["start_period"], "600s")


if __name__ == "__main__":
  unittest.main()
