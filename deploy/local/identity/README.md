# Local OIDC realm

`eisenhower-realm.json` is the production-shaped startup import for the local
Keycloak 26.7.x service. It contains no users and enables no Direct Access
Grant. The web and MCP clients are pre-registered Authorization Code + PKCE
clients; the API is a bearer-only audience.

The access-token contract consumed by Node and Python is:

- issuer: `${OIDC_PUBLIC_ORIGIN}/realms/eisenhower`
- API audience: `eisenhower-api`
- incoming MCP audiences: `${OIDC_MCP_RESOURCE_URL}` and
  `eisenhower-mcp-exchange`
- JWKS: `${OIDC_PUBLIC_ORIGIN}/realms/eisenhower/protocol/openid-connect/certs`
- identity claims: `sub`, `tenant_id`, `roles`, `project_ids`
- permissions in `scope`: `tasks:read`, `tasks:write`, `calendar:read`,
  `calendar:write`, `knowledge:read`, `ai:analyze`; MCP tokens additionally
  require `mcp:tools`

The confidential `eisenhower-mcp-exchange` client uses supported standard token
exchange. Its secret comes from the environment. An incoming token is bound to
the MCP resource URL and the exchange client; the exchanged token is bound to
the bearer-only `eisenhower-api` client. OAuth Client ID Metadata Documents and
dynamic registration remain disabled. The local deployment uses explicit
pre-registration because no reviewed declarative allowlist of trusted CIMD
domains is part of this import.

`e2e/eisenhower-e2e-realm.json` is a separate, non-production fixture. It is not
mounted by the normal identity service. Its two users deliberately share
`tenant_id=local-e2e` but have different stable subjects and disjoint
`project_ids`, enabling a meaningful same-tenant owner-isolation check. Only
this fixture enables Direct Access Grant so a test harness can obtain tokens
without browser clicks.

Keycloak substitutes redirect values, the exchange secret and fixture
passwords from its environment while importing. No password or concrete client
secret belongs in this directory. Production Compose must mount only
`eisenhower-realm.json` and fail before startup when a required value is empty.
