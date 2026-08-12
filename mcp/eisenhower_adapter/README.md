# Eisenhower MCP adapter

This is a thin, query-only adapter over the public Eisenhower HTTP API. It exposes exactly:

- `matrix_summary`
- `tasks_search`
- `task_get`
- `project_context`
- `knowledge_search`
- `priority_explain`

It intentionally exposes no mutation, arbitrary URL fetch, shell command, n8n executor, or generic workflow tool. `task_get` and `project_context` currently derive their answer from the existing `GET /tasks` endpoint; the response states the current project-metadata limitation rather than inventing data. `knowledge_search` expects the versioned public `POST /v2/knowledge/search` contract and returns its citations unchanged.

## Transport and authentication

The default transport is local `stdio`. Set `MCP_TRANSPORT=streamable-http` only behind a trusted gateway that implements MCP authorization, Origin validation, TLS, and rate limiting. The adapter sends its upstream credential only in the `Authorization: Bearer` header. Remote upstream URLs must be HTTPS; loopback HTTP is allowed for local development.

Configuration:

| Variable | Required | Meaning |
| --- | --- | --- |
| `EISENHOWER_TASK_API_BASE_URL` | yes | Task API base URL, for example local Node on port 3001 |
| `EISENHOWER_AI_API_BASE_URL` | yes | AI API base URL, for example local FastAPI on port 8000 |
| `EISENHOWER_API_TOKEN` | production | Scoped read-only bearer token |
| `EISENHOWER_API_TIMEOUT_SECONDS` | no | Upstream timeout, default 5 seconds |
| `MCP_TRANSPORT` | no | `stdio` by default |
| `MCP_HOST` | no | Streamable HTTP loopback bind, default `127.0.0.1`; non-loopback is rejected |
| `MCP_PORT` | no | Streamable HTTP port, default `8000` |
| `MCP_HTTP_PATH` | no | Streamable HTTP path, default `/mcp` |
| `MCP_MAX_REQUEST_BODY_BYTES` | no | Request-body limit, default 1 MiB |
| `EISENHOWER_AUDIT_DB_PATH` | yes | Durable SQLite audit path shared with or separately retained beside the AI ledger |
| `EISENHOWER_AUDIT_HMAC_KEY_FILE` | yes | `0600`, minimum 32-byte audit key file; never a tool argument |
| `EISENHOWER_RELEASE_SHA` | yes | Exact 40-character lowercase release SHA |
| `EISENHOWER_AUDIT_TENANT_ID` | yes | Server-owned tenant identity to pseudonymize |
| `EISENHOWER_AUDIT_ACTOR_ID` | yes | Server-owned MCP client identity to pseudonymize |

Do not put secrets in the URL or tool arguments. Tenant/user/project scope comes only from verified bearer-token claims; the adapter never sends a client-controlled tenant header. The public API remains responsible for authorization, rate limiting, and audit events for sensitive reads.

Every tool call writes content-free attempt/result events and fails closed before the upstream HTTP
call when durable audit is unavailable. The local monorepo launch must make the canonical audit
module importable, for example with `PYTHONPATH=backend-ai`; a standalone packaged deployment must
package that same module rather than silently substituting a second audit format.

The adapter uses the official MCP Python SDK v2 `MCPServer`, pinned to
`mcp==2.0.0`. Before enabling a remote transport, apply the current [MCP
authorization specification](https://modelcontextprotocol.io/specification/latest/basic/authorization),
bind the server to a private interface by default, validate browser `Origin`,
and test confused-deputy/token-audience boundaries. Tool descriptions and
upstream knowledge are untrusted input; the adapter never turns them into
executable workflow names or URLs.

Run focused tests after installing the adapter in an isolated environment:

```bash
python3 -m venv /tmp/eisenhower-mcp-test
/tmp/eisenhower-mcp-test/bin/pip install -e mcp/eisenhower_adapter
PYTHONPATH=mcp/eisenhower_adapter /tmp/eisenhower-mcp-test/bin/python -m unittest discover -s mcp/eisenhower_adapter/tests -v
```
