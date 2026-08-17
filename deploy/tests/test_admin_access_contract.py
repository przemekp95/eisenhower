from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GATEWAY_TEMPLATE = ROOT / "deploy" / "local" / "access-gateway.conf.template"
REALM_IMPORT = ROOT / "deploy" / "local" / "identity" / "eisenhower-realm.json"


def _location_block(config: str, path: str) -> str:
  marker = f"location {path} {{"
  start = config.index(marker) + len(marker)
  end = config.index("\n    }", start)
  return config[start:end]


def test_admin_routes_delegate_authorization_to_private_oauth2_proxy():
  config = GATEWAY_TEMPLATE.read_text(encoding="utf-8")

  auth = _location_block(config, "= /oauth2/auth")
  assert "proxy_pass http://$admin_auth_upstream" in auth
  assert "proxy_pass_request_body off" in auth

  for path in ("/admin/n8n/", "/admin/prometheus/", "/admin/grafana/"):
    route = _location_block(config, path)
    assert "auth_request /oauth2/auth" in route
    assert "error_page 401 = /oauth2/start" in route


def test_calendar_webhook_is_the_only_public_n8n_route():
  config = GATEWAY_TEMPLATE.read_text(encoding="utf-8")
  webhook = _location_block(config, "= /eisenhower/google-calendar/webhook")

  assert "auth_request" not in webhook
  assert "proxy_pass http://$n8n_upstream/webhook/eisenhower-google-calendar" in webhook
  assert config.count("proxy_pass http://$n8n_upstream") == 2


def test_keycloak_has_dedicated_admin_role_and_confidential_client():
  realm = json.loads(REALM_IMPORT.read_text(encoding="utf-8"))
  roles = {role["name"] for role in realm["roles"]["realm"]}
  clients = {client["clientId"]: client for client in realm["clients"]}

  assert "eisenhower-admin" in roles
  admin_client = clients["eisenhower-admin-access"]
  assert admin_client["publicClient"] is False
  assert admin_client["standardFlowEnabled"] is True
  assert admin_client["directAccessGrantsEnabled"] is False
  assert admin_client["secret"] == "${ADMIN_OIDC_CLIENT_SECRET}"
  assert admin_client["redirectUris"] == ["${ADMIN_OIDC_REDIRECT_URI}"]
