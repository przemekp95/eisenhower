from __future__ import annotations

import json
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
GATEWAY_TEMPLATE = ROOT / "deploy" / "local" / "access-gateway.conf.template"
REALM_IMPORT = ROOT / "deploy" / "local" / "identity" / "eisenhower-realm.json"
IDENTITY_BOOTSTRAP = ROOT / "deploy" / "local" / "identity" / "ensure-admin-access.sh"
ADMIN_SCOPE_IMPORT = ROOT / "deploy" / "local" / "identity" / "eisenhower-admin-claims.json"
GRAFANA_CONFIG = ROOT / "monitoring" / "grafana" / "grafana.ini"


def _location_block(config: str, path: str) -> str:
  marker = f"location {path} {{"
  start = config.index(marker) + len(marker)
  end = config.index("\n    }", start)
  return config[start:end]


def test_admin_routes_delegate_authorization_to_private_oauth2_proxy():
  config = GATEWAY_TEMPLATE.read_text(encoding="utf-8")

  auth = _location_block(config, "= /oauth2/auth")
  assert "internal;" in auth
  assert "proxy_pass http://$admin_auth_upstream" in auth
  assert "proxy_pass_request_body off" in auth

  for path in ("/admin/n8n/", "/admin/prometheus/", "/admin/grafana/"):
    route = _location_block(config, path)
    assert "auth_request /oauth2/auth" in route
    assert "error_page 401 = /oauth2/start" in route
    assert "auth_request_set $auth_cookie $upstream_http_set_cookie" in route
    assert "add_header Set-Cookie $auth_cookie" in route
    assert "$upstream_cookie__eisenhower_admin_1" in route
  assert "proxy_pass http://$n8n_upstream/;" in _location_block(config, "/admin/n8n/")
  assert "${ACCESS_ADMIN_ALLOWED_ORIGIN}" in config
  assert 'map "$uri|$admin_origin_match" $admin_origin_allowed' in config
  assert '~^/admin/.*\\|1$ 1;' in config
  assert '~^/oauth2/.*\\|1$ 1;' in config
  oauth = _location_block(config, "/oauth2/")
  assert "X-Auth-Request-Redirect $request_uri" in oauth
  assert "X-Auth-Request-Redirect $scheme://$http_host$request_uri" not in oauth


def test_calendar_webhook_is_the_only_public_n8n_route():
  config = GATEWAY_TEMPLATE.read_text(encoding="utf-8")
  webhook = _location_block(config, "= /eisenhower/google-calendar/webhook")

  assert "auth_request" not in webhook
  assert "proxy_pass http://$n8n_upstream/webhook/eisenhower-google-calendar" in webhook
  assert 'proxy_set_header Cookie ""' in webhook
  assert 'proxy_set_header X-WEBAUTH-USER ""' in webhook
  assert 'proxy_set_header X-Auth-Request-User ""' in webhook
  assert 'proxy_set_header X-Auth-Request-Email ""' in webhook
  assert 'proxy_set_header X-Auth-Request-Groups ""' in webhook
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
  assert admin_client["defaultClientScopes"] == ["eisenhower-admin-claims"]
  scopes = {scope["name"]: scope for scope in realm["clientScopes"]}
  assert scopes["eisenhower-admin-claims"] == json.loads(
    ADMIN_SCOPE_IMPORT.read_text(encoding="utf-8")
  )
  mappers = {mapper["name"]: mapper for mapper in scopes["eisenhower-admin-claims"]["protocolMappers"]}
  assert mappers["realm-roles"]["config"]["claim.name"] == "realm_access.roles"
  assert mappers["preferred-username"]["config"]["claim.name"] == "preferred_username"
  assert mappers["email"]["config"]["claim.name"] == "email"


def test_existing_keycloak_realm_gets_an_idempotent_admin_access_migration():
  compose = yaml.safe_load((ROOT / "compose.yaml").read_text(encoding="utf-8"))
  services = compose["services"]
  bootstrap = services["identity-admin-bootstrap"]
  script = IDENTITY_BOOTSTRAP.read_text(encoding="utf-8")

  assert bootstrap["restart"] == "no"
  assert not bootstrap.get("ports")
  assert bootstrap["depends_on"]["identity-service"]["condition"] == "service_started"
  assert services["oauth2-proxy"]["depends_on"]["identity-admin-bootstrap"]["condition"] == "service_completed_successfully"
  assert services["gateway"]["depends_on"]["identity-admin-bootstrap"]["condition"] == "service_completed_successfully"
  assert "roles/eisenhower-admin" in script
  assert "clientId=eisenhower-admin-access" in script
  assert "name=eisenhower-admin-claims" in script
  assert "kcadm.sh update" in script
  assert "client-scopes/$scope_uuid/protocol-mappers/models" in script
  for mapper in ("preferred-username", "email", "realm-roles"):
    assert f"{mapper}.json" in script
  assert "directAccessGrantsEnabled=false" in script


def test_oauth_proxy_requests_only_scopes_defined_by_the_realm():
  compose = yaml.safe_load((ROOT / "compose.yaml").read_text(encoding="utf-8"))
  command = compose["services"]["oauth2-proxy"]["command"]

  assert "--scope=openid" in command
  assert not any(item.startswith("--scope=") and item != "--scope=openid" for item in command)


def test_oauth_proxy_uses_bounded_refreshable_sessions_and_internal_oidc_endpoints():
  compose = yaml.safe_load((ROOT / "compose.yaml").read_text(encoding="utf-8"))
  command = compose["services"]["oauth2-proxy"]["command"]

  assert "--cookie-expire=15m" in command
  assert "--cookie-refresh=1m" in command
  assert "--skip-oidc-discovery=true" in command
  assert "--login-url=${OIDC_ISSUER:?OIDC_ISSUER is required}/protocol/openid-connect/auth" in command
  assert "--redeem-url=http://identity-service:8080/identity/realms/eisenhower/protocol/openid-connect/token" in command
  assert "--profile-url=http://identity-service:8080/identity/realms/eisenhower/protocol/openid-connect/userinfo" in command
  assert "--oidc-jwks-url=http://identity-service:8080/identity/realms/eisenhower/protocol/openid-connect/certs" in command


def test_grafana_cannot_install_or_auto_update_plugins_at_runtime():
  compose = yaml.safe_load((ROOT / "compose.yaml").read_text(encoding="utf-8"))
  environment = set(compose["services"]["grafana"]["environment"])

  assert "GF_ANALYTICS_CHECK_FOR_UPDATES=false" in environment
  assert "GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false" in environment
  assert "GF_PLUGINS_PLUGIN_ADMIN_ENABLED=false" in environment
  assert "GF_PLUGINS_PREINSTALL_DISABLED=true" in environment
  assert "preinstallAutoUpdate = false" in GRAFANA_CONFIG.read_text(encoding="utf-8")
