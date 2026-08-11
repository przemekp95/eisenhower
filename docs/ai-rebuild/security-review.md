# Security and privacy review

Scope: Express and FastAPI HTTP, the same-origin web proxy, browser/mobile clients, Qdrant, vLLM, n8n webhooks/jobs and MCP. This is a threat review and required control set, not proof that a production security assessment has passed.

## Trust boundaries

```mermaid
flowchart TB
  INTERNET((Untrusted network)) --> EDGE[Public TLS / edge]
  BROWSER[Browser / mobile] --> EDGE
  EDGE --> WEB[Web Nginx /api and /ai proxy]
  WEB --> NODE[Express task API]
  WEB --> API[FastAPI AI API]
  MCPCLIENT[MCP client] --> MCP[MCP adapter]
  MCP --> EDGE
  API --> Q[(Private Qdrant)]
  API --> V[Private vLLM]
  SOURCE[Allowlisted source] --> WH[Signed webhook ingress]
  WH --> N[n8n private]
  N --> API
  API --> STORE[(Canonical store / job store)]
  API --> OBS[Sanitized audit/telemetry]
```

The target exposes only the public edge and keeps Express, FastAPI, Qdrant, vLLM, n8n UI/workers and internal command endpoints private. The shipped web Nginx provides the same-origin `/api` and `/ai` hop inside Compose; repository configuration does not prove the external TLS/edge boundary. Network location is defense in depth, not identity.

## Required controls

| Axis | Threat | Required control | Local evidence / gap |
| --- | --- | --- | --- |
| Bearer/OAuth | stolen/forged tokens, confused deputy | OIDC issuer/audience/expiry/signature validation; narrow scopes; short TTL; key rotation; separate service audience | The shared web client supplies `Authorization: Bearer`; Express and FastAPI bearer/OIDC verification exists; live IdP and rotation are unverified |
| CSRF/browser requests | cross-site state change | Use explicit Authorization rather than ambient cookie auth; exact CORS allowlist; reject untrusted `Origin` on unsafe methods; if cookies are introduced, add CSRF token + SameSite policy | The web adapter uses `credentials: 'omit'`; both APIs reject an untrusted present Origin and ignore cookies for auth; public edge behavior remains unverified |
| CORS | hostile browser origin or credential leakage | Never wildcard with credentials; allow only required origins/methods/headers; validate preflight and reverse-proxy headers | Express uses `credentials: false`; FastAPI uses `allow_credentials=False`; both use configured allowlists, but production origins/runtime headers are unverified |
| HTTP transport | interception, smuggling, redirect/token leak | TLS externally and private TLS/mTLS where required; fixed upstream URLs; no redirects for credentials; request/body limits; proxy normalization | Web Nginx proxies `/api` and `/ai` over Compose HTTP and sets forwarded headers; the vLLM adapter rejects public endpoints and redirects; end-to-end TLS and trusted proxy normalization are unknown |
| SSRF | connector or model induces fetch | Dedicated allowlisted connectors; parse/resolve host; block loopback/link-local/metadata/private ranges as policy requires; pin redirect/DNS behavior; no generic fetch tool | vLLM URL fixed; source fetch boundary not implemented end to end |
| Webhooks | forgery/replay/body ambiguity | Versioned HMAC over timestamp + method + path + exact raw bytes; constant-time compare; five-minute window; durable unique event ID longer than retry; fail-closed schema/body limit | FastAPI and the inactive n8n workflow now preserve exact raw bytes locally, bind `v1`/`POST`/the ingress path, enforce 8 MiB plus strict schema parsing and reserve replay IDs atomically for 24 hours; no imported workflow or deployed ingress is claimed |
| Prompt injection | corpus tells model to ignore policy/exfiltrate | Treat task/context/tool text as data; delimit context; minimal system prompt; no tools for generator; validate JSON/citations; redact secrets before index | Prompt warns that chunks are untrusted; adversarial evaluation still required |
| Tenant isolation | cross-tenant vector/task leak | Derive identity from verified token; mandatory tenant + ACL filters; validate requested project; deny cross-tenant admin wildcard; negative tests and audit | Qdrant filter and request scope exist locally; real-db isolation tests required |
| Secrets/PII | leakage through corpus, logs, n8n executions, prompts | secret manager; data minimization; classification/redaction; encryption; retention/deletion; sanitized errors; no raw prompt/content logs by default | Config uses environment variables; secret manager/data policy/runtime review missing |
| Rate limits | cost/availability abuse | per-principal/tenant/IP budgets by endpoint; concurrent generation cap; request size limits; retry budget; 429/Retry-After | A local per-principal sliding-window limit protects the v2 AI routes; it is in-memory and not distributed |
| Audit log | repudiation or invisible sensitive reads | append-only events for auth decisions, corpus commands, reindex/alias, admin changes, MCP sensitive reads; actor/tenant/action/resource/outcome/correlation, never secrets/content | Hashed-subject audit events for v2/internal requests exist locally; a durable compliant audit sink/schema/retention is not implemented |

## Authentication and authorization contract

Required scopes include `ai:analyze`, `knowledge:read`, narrowly scoped ingestion commands and explicit admin operations. The token determines `tenant_id`, `user_id`, roles and allowed projects. Client headers/body fields may narrow this set but can never expand it. Static tokens are development-only unless an explicitly accepted single-tenant exception has high-entropy rotation and gateway protections.

OIDC/JWT verification must allowlist algorithms, require issuer/audience/subject/tenant/issued-at/expiry, cache JWKS safely, fail closed and bound network timeouts. Never accept identity from `X-Tenant-ID` unless a trusted gateway strips and re-signs it under a documented protocol.

## Browser, mobile and CSRF

The web/shared client supplies bearer tokens in the `Authorization` header, and neither API authenticates through ambient cookies. Classic credentialed CSRF is therefore not applicable to the current authentication contract. Malicious origins and token exfiltration still matter: unsafe browser methods validate a present `Origin`, while a missing Origin is accepted for authenticated non-browser clients. CORS is browser response policy, not authentication, and both APIs disable credentialed CORS.

The production web adapter explicitly sets `credentials: 'omit'` for every task and AI request while preserving the bearer header. A regression test covers both client factories. This is defense in depth for the current bearer-only contract, not permission to weaken backend authentication, Origin checks or CORS. Do not persist long-lived tokens in `localStorage`; use platform-secure storage/mobile keystore or a reviewed BFF/session design.

If browser auth later changes to cookies, this review must be reopened: use `Secure`, `HttpOnly`, restrictive `SameSite`, per-request CSRF protection for unsafe methods, and login/logout CSRF defenses.

## Same-origin proxy boundary

`web/nginx.conf` routes `/api/` to `api-service:3001` and `/ai/` to `ai-service:8000` over the Compose network. Nginx forwards request headers by default and explicitly sets `Host`, `X-Real-IP`, `X-Forwarded-For` and `X-Forwarded-Proto`; it does not replace bearer or Origin validation in either API. This local configuration is not evidence that a public TLS terminator preserves the required headers, normalizes conflicting forwarded headers, limits requests correctly or avoids redirects. Verify those properties against the deployed edge and exact release SHA.

## Webhook and job security

The local FastAPI integration authenticates internal calls with a dedicated service token, restricts it to configured tenant IDs, verifies a versioned timestamp/method/path/exact-raw-body HMAC, atomically rejects replayed `event_id` values in SQLite for 24 hours, signs the validated internal dispatch and enqueues one of four allowlisted commands with `Idempotency-Key == event_id`. The parser rejects invalid UTF-8, duplicate fields, non-finite JSON, unknown fields and operation-incomplete envelopes before reserving the event ID. The local worker claims with expiring leases, reclaims crashed work, validates checksums/versions/ACL mapping, retries transient failures with bounded jitter and dead-letters permanent or exhausted work. This is integrated local code and an inactive import artifact, not evidence that n8n or a worker is running or that the gateway preserves the contract. Credential scope authorizes the tenant and operation; envelope fields only describe requested work.

Retry network/5xx failures with exponential backoff and jitter. Do not retry authentication, schema, ACL, checksum or permanent 4xx errors. Cap attempts and place exhausted work in a dead-letter state with sanitized alerts and manual replay authorization.

## Prompt/data exfiltration controls

- No secrets, raw credentials, private hidden prompts or unrestricted history in the corpus.
- Retrieved chunks are quoted as untrusted data; no instruction from a chunk changes system policy.
- The generation provider has no general HTTP, shell, database or n8n tool.
- Limit context chunks and bytes; escape/delimit IDs and content; require structured output.
- Accept only cited IDs returned by the current retriever and enforce ACL before generation.
- Golden attacks include “ignore previous instructions”, fake XML/JSON boundary closure, secret requests, cross-tenant references and citation fabrication.
- Responses must avoid revealing whether an inaccessible document exists.

## MCP-specific review

Local `stdio` minimizes network exposure. Remote HTTP requires the current MCP authorization specification, HTTPS, strict `Origin`, an audience-bound token, trusted gateway, private bind, connection/request limits and audit. Tool names are a static allowlist. Never expose arbitrary URL, command, workflow, database query, prompt, credential or filesystem tools. Upstream API tokens remain server configuration, not tool input/output.

## Security release gate

No-go for production until threat owners sign off the unresolved rows, secrets are externally managed, the raw-body webhook contract passes against an imported n8n workflow and the real gateway, tenant-negative integration tests pass, rate limiting and audit storage exist, penetration testing covers HTTP/MCP/prompt injection, and incident/rotation/deletion runbooks are rehearsed.
