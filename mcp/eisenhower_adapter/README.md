# Eisenhower MCP adapter

This is a thin, bounded adapter over the public Eisenhower HTTP API. It exposes read tools:

- `matrix_summary`
- `tasks_search`
- `task_get`
- `project_context`
- `knowledge_search`
- `priority_explain`

and narrow write tools:

- `task_create`
- `task_update`
- `task_lifecycle`
- `task_schedule`
- `task_delegation`
- `calendar_sync_status`
- `calendar_sync_request`
- `calendar_conflicts_list`
- `calendar_conflict_resolve`

It intentionally exposes no final delete, arbitrary URL fetch, shell command, n8n executor, or generic workflow tool. Every task mutation requires an idempotency key; every mutation of an existing task also requires `expected_revision`, mapped to the upstream `If-Match` precondition. Scheduling and delegation require one explicit mode so a missing argument cannot silently clear state. `task_get` and `project_context` currently derive their answer from the existing `GET /tasks` endpoint; the response states the current project-metadata limitation rather than inventing data. `knowledge_search` expects the versioned public `POST /v2/knowledge/search` contract and returns its citations unchanged.

Calendar tools use only the published status, sync-request, conflict-list, and conflict-resolution contracts. Sync requests require an idempotency key; conflict resolution additionally requires the expected conflict revision and allows only `eisenhower` or `google` as the strategy. The adapter does not accept or construct caller-selected endpoints.

## Transport and authentication

The default transport is local `stdio`. Remote `streamable-http` is an OAuth 2.0 resource server backed by a Keycloak-compatible issuer. It verifies RS256 access tokens locally through a bounded, cached JWKS fetch and requires the exact public MCP resource URL as its audience plus transport scope `mcp:tools`. Every tool additionally checks one canonical least-privilege scope: `tasks:read`, `tasks:write`, `calendar:read`, `calendar:write`, or `knowledge:read`.

Remote mode never forwards the MCP bearer token. It performs RFC 8693 token exchange as a confidential MCP client and sends only the resulting `eisenhower-api` audience token to Node/AI. The exchange result is verified again for issuer, audience, subject, tenant and non-expanded scopes. Local `stdio` may continue to use an explicitly configured `EISENHOWER_API_TOKEN`. Remote upstream URLs, issuer, JWKS URL and token endpoint must be HTTPS; loopback HTTP remains allowed only for local upstream development.

Configuration:

| Variable | Required | Meaning |
| --- | --- | --- |
| `EISENHOWER_TASK_API_BASE_URL` | yes | Task API base URL, for example local Node on port 3001 |
| `EISENHOWER_AI_API_BASE_URL` | yes | AI API base URL, for example local FastAPI on port 8000 |
| `EISENHOWER_API_TOKEN` | stdio only | Explicit scoped bearer token; ignored for authenticated remote requests |
| `EISENHOWER_API_TIMEOUT_SECONDS` | no | Upstream timeout, default 5 seconds |
| `MCP_TRANSPORT` | no | `stdio` by default |
| `MCP_HOST` | no | Streamable HTTP loopback bind, default `127.0.0.1`; non-loopback is rejected |
| `MCP_PORT` | no | Streamable HTTP port, default `8000` |
| `MCP_HTTP_PATH` | no | Streamable HTTP path, default `/mcp` |
| `MCP_MAX_REQUEST_BODY_BYTES` | no | Request-body limit, default 1 MiB |
| `MCP_OIDC_ISSUER` | remote | Exact Keycloak realm issuer URL |
| `MCP_OIDC_AUDIENCE` | remote | Exact public MCP resource URL used as the audience |
| `MCP_OIDC_JWKS_URL` | remote | Realm JWKS URL for RS256 verification |
| `MCP_RESOURCE_SERVER_URL` | remote | Public MCP URL used for RFC 9728 protected-resource metadata |
| `MCP_OIDC_TOKEN_ENDPOINT` | remote | Keycloak token endpoint used for RFC 8693 token exchange |
| `MCP_OIDC_CLIENT_ID` | remote | Confidential MCP client ID |
| `MCP_OIDC_CLIENT_SECRET` | remote | Confidential MCP client secret; environment only |
| `EISENHOWER_API_AUDIENCE` | remote | Exchanged upstream audience, normally `eisenhower-api` |
| `MCP_OIDC_TENANT_CLAIM` | no | Verified tenant claim name, default `tenant_id` |
| `MCP_OIDC_TIMEOUT_SECONDS` | no | JWKS and exchange timeout, default 3 seconds |
| `MCP_OIDC_JWKS_CACHE_SECONDS` | no | JWKS cache TTL, default 300 seconds |
| `EISENHOWER_AUDIT_DB_PATH` | yes | Durable SQLite audit path shared with or separately retained beside the AI ledger |
| `EISENHOWER_AUDIT_HMAC_KEY_FILE` | yes | `0600`, minimum 32-byte audit key file; never a tool argument |
| `EISENHOWER_RELEASE_SHA` | yes | Exact 40-character lowercase release SHA |
| `EISENHOWER_AUDIT_TENANT_ID` | stdio | Static local tenant identity to pseudonymize |
| `EISENHOWER_AUDIT_ACTOR_ID` | stdio | Static local actor identity to pseudonymize |

Do not put secrets in the URL or tool arguments. In remote mode, tenant and actor audit identities come dynamically from the verified token's tenant claim and `sub`; static single-user identities are not accepted as a remote fallback. The adapter never sends a client-controlled tenant header. The public API remains responsible for object authorization, rate limiting, and audit events for sensitive reads.

Every tool call writes content-free attempt/result events and fails closed before the upstream HTTP
call when durable audit is unavailable. The local monorepo launch must make the canonical audit
module importable, for example with `PYTHONPATH=backend-ai`; a standalone packaged deployment must
package that same module rather than silently substituting a second audit format.

The adapter uses the official MCP Python SDK v2 `MCPServer`, pinned to
`mcp==2.0.0`, its `AuthSettings`/`TokenVerifier` resource-server boundary, and
the SDK-provided RFC 9728 protected-resource metadata route. Keep the process
behind a TLS reverse proxy with strict browser `Origin` validation and rate limits.
Tool descriptions and
upstream knowledge are untrusted input; the adapter never turns them into
executable workflow names or URLs.

Run focused tests after installing the adapter in an isolated environment:

```bash
python3 -m venv /tmp/eisenhower-mcp-test
/tmp/eisenhower-mcp-test/bin/pip install -e mcp/eisenhower_adapter
PYTHONPATH=mcp/eisenhower_adapter /tmp/eisenhower-mcp-test/bin/python -m unittest discover -s mcp/eisenhower_adapter/tests -v
```
