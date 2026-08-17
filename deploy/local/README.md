# Local production topology

This topology runs on one local Linux host by default and keeps every location-sensitive connection
configurable. The default action is deliberately small: it does not start retrieval, generation,
reranking, n8n or Keycloak.

## What is deployable now

The AI runtime is split by actual role without adding public entrypoints:

- `ai-service` is the dependency-light Bearer/OIDC, exact-Origin, CORS and audit boundary. It proxies only
  to fixed private role URLs, bounds bodies, pools and timeouts, and refuses redirects with credentials.
- `classifier-service` owns classification and requires a read-only, approved generation pointer whose
  SHA-256 matches `LOCAL_MODEL_APPROVED_ARTIFACT_SHA256`. Production startup never trains a model.
- `knowledge-service` owns online retrieval/answering. Mongo remains canonical and Qdrant remains a
  rebuildable projection; the HTTP boundary and the RAG ports keep framework-specific types internal.
- `rag-worker` is the single ingest/OCR/Docling worker. It shares one SQLite queue volume with the producer,
  verifies webhook HMAC/idempotency and has a measured, mandatory queue bound.

The default `core` graph contains only MongoDB, Node API, audit initialization, the AI boundary and the
classifier. Qdrant/knowledge/worker are opt-in retrieval roles; vLLM generation and reranking are opt-in AMD
roles; n8n/Calendar and Keycloak/access remain explicit profiles. The Mongo transactional outbox stays in
the Node process; there is intentionally no invented outbox service.

| Action | Starts | Explicitly excludes |
| --- | --- | --- |
| `deploy` / `deploy-core` | core | Qdrant, knowledge, worker, vLLM, reranker, n8n, Keycloak |
| `deploy-access-core` | core + identity/access + web + MCP | Qdrant, knowledge, worker, vLLM, reranker, n8n, Calendar |
| `deploy-retrieval` | core + Qdrant + knowledge + one worker + reranker | generation, n8n, Keycloak |
| `deploy-response` | retrieval + private generation + identity/access/web/MCP | n8n and Calendar |
| `deploy-full` | the former complete local topology | nothing |

Each matching `render-*` action renders only its graph. All first-party images are tagged from exact clean
`HEAD`, checked through the OCI revision label and recorded for rollback before mutation.

## First same-host deployment

1. Build and tag each role for one exact Git SHA. Do not use mutable `latest` tags.

   ```bash
   release_sha="$(git rev-parse HEAD)"
   docker build --target production -f backend-node/Dockerfile \
     -t "local/eisenhower-api:${release_sha}" .
   for role in boundary classifier knowledge ingest; do
     docker build --target "$role" --build-arg RELEASE_SHA="$release_sha" \
       -f backend-ai/Dockerfile -t "local/eisenhower-ai-${role}:${release_sha}" backend-ai
   done
   docker build -f mcp/eisenhower_adapter/Dockerfile \
     -t "local/eisenhower-mcp:${release_sha}" .
   docker build --target production -f web/Dockerfile \
     -t "local/eisenhower-web:${release_sha}" .
   ```
2. Copy `.env.example` to an owner-only `.env` with mode `0600` and populate the role-specific image refs,
   secrets and measured CPU/RAM/PID/thread/queue limits. Blank qualification values are intentional hard
   failures; the previous monolith's peaks are evidence floors, not recommended role limits.

   `AI_CLASSIFIER_ARTIFACT_ROOT` must contain the offline-trained atomic generation pointer and immutable
   artifacts. The pointer digest is a separate required input. An owner-approved evaluation is still required;
   a time-bounded owner bypass is recorded as a bypass and never as fabricated human evidence. If responses
   are enabled, the promotion controller's `current.json`, candidate ID and tenant/user allowlists are also
   mandatory.

   Retrieval also requires an explicitly prepared Docling layout-model bundle. Preparing it is an offline
   operator action, never a builder or production-startup download:

   ```bash
   PYTHONPATH=backend-ai backend-ai/venv/bin/python \
     backend-ai/scripts/prepare_docling_artifact.py --output /absolute/new/revision-directory
   ```

   Set `AI_DOCLING_ARTIFACT_ROOT` to that directory and
   `DOCLING_ARTIFACTS_MANIFEST_SHA256` to the digest printed by the command. Deployment verifies the manifest
   before starting retrieval; the worker mounts the bundle read-only and verifies the pinned repository,
   revision, complete file set, sizes and SHA-256 hashes before constructing Docling.

3. Render without pulling or starting containers, then choose exactly one deployment action:

   ```bash
   deploy/local/deploy.sh render-core
   deploy/local/deploy.sh render-access-core
   deploy/local/deploy.sh render-retrieval
   deploy/local/deploy.sh render-response
   deploy/local/deploy.sh render-full
   deploy/local/deploy.sh deploy-core
   deploy/local/deploy.sh deploy-access-core
   ```

This binds host ports to `127.0.0.1` by default. Compose DNS names provide same-host service-to-service
URLs. A reverse proxy or private client may reach only the endpoints explicitly selected by the owner.

## User-facing core rollout without GPU

`deploy-access-core` extends the CPU-only core with Keycloak, the web UI, Remote MCP and the access gateway,
without starting Qdrant, the knowledge/ingest roles, vLLM generation, reranking, n8n or the Calendar gateway:

```bash
deploy/local/deploy.sh render-access-core
deploy/local/deploy.sh deploy-access-core
```

The CPU classifier remains available when its existing production approval gate passes. Node task readiness is
independent of AI health, and the UI reports optional AI failures with retry and a manual quadrant path. AI and
knowledge requests retain the same OIDC, bearer, CORS/origin, audit and proxy allowlist controls; missing private
retrieval or GPU roles cannot produce an ungrounded answer.

## Private vLLM lifecycle

vLLM 0.20 development sleep endpoints are not enabled: its API key protects `/v1`, while development-mode
sleep/control routes are outside that stable authenticated surface. The supported control is private
orchestrator scale-to-zero:

```bash
LIFECYCLE_OPERATOR_TOKEN='from-a-separate-secret-source' deploy/local/deploy.sh sleep-response
LIFECYCLE_OPERATOR_TOKEN='from-a-separate-secret-source' deploy/local/deploy.sh wake-response
```

The operator token is compared in constant time and is not an HTTP endpoint. Wake starts only inference and
reranker, probes authenticated `/v1/models` until the mandatory timeout, and stops a partially started pair on
failure. Normal request handling remains fail-closed behind readiness, application timeouts and the existing
generation circuit breaker. The current ROCm knowledge image remains vLLM-derived until a clean physical
gfx1151 benchmark qualifies a pinned dedicated PyTorch/ROCm image; no storage or RAM saving is claimed before
that gate.

Before either gateway and the final smoke check, deployment stops n8n, reconciles the five allowlisted
repository workflows by stable ID, removes exact-name stale duplicates, verifies the installed definitions,
and restarts n8n. If reconciliation fails, it restores the pre-reconcile SQLite snapshot and restarts the
last known runtime before the deployment fails closed. Calendar workflows are published by default. RAG workflows require both
`N8N_RAG_WORKFLOWS_ENABLED=true`, a live `knowledge-service`, and an existing `httpHeaderAuth` credential
selected by `N8N_RAG_HEADER_AUTH_CREDENTIAL_ID`; otherwise they remain unpublished. Use
`deploy/local/deploy.sh reconcile-n8n` to repeat only this step. Use
`n8n/scripts/rehearse-runtime.sh` for a disposable n8n 2.4.6 import/publish/start rehearsal; it does not mount
the deployment volume and does not contact Google.

## Multi-user OIDC and Remote MCP

`identity-service` imports the production-shaped `eisenhower` realm from
`identity/eisenhower-realm.json`. It contains no users and enables no password grant. Browser and MCP
clients are pre-registered Authorization Code + PKCE clients. Stable `sub` and `tenant_id` claims form
the identity boundary; scopes separately authorize tasks, Calendar, knowledge and AI access.

`access-gateway` is the only supported remote ingress for identity, API and MCP. It binds to loopback,
validates the exact Host and browser Origin, rate-limits requests, bounds bodies and timeouts, disables
access logs, re-resolves Docker upstreams after container replacement and publishes the RFC 9728
protected-resource metadata route. Place only this loopback port
behind private Tailscale Serve (not Funnel), for example on an otherwise unused HTTPS port. Do not expose
Keycloak, Node, FastAPI or MCP container ports directly.

The same gateway serves the web UI at `/`. The UI uses the pre-registered `eisenhower-web` public client
with Authorization Code and S256 PKCE, validates callback state, keeps the verifier only in
`sessionStorage`, and keeps the resulting access token only in process memory. API and AI requests stay
same-origin under `/api` and `/ai`; the browser never receives service credentials.

An MCP access token must target the exact public MCP resource URL and include `mcp:tools` plus the
least-privilege tool scope. The MCP service verifies that token locally and performs RFC 8693 token
exchange for a separate `eisenhower-api` audience token. It never forwards the incoming MCP token to
Node or FastAPI. The exchanged token is re-verified for unchanged subject and tenant and non-expanded
scopes. Keycloak's current local configuration uses pre-registered clients and audience mappers; dynamic
client registration and CIMD are deliberately disabled.

The fixture under `identity/e2e/` is test-only. It contains two synthetic subjects in the same tenant and
is never mounted by production Compose. Its password grant exists solely so automated isolation tests can
obtain tokens without a browser.

## Public Google Calendar gateway

`calendar-gateway` is a separately placeable nginx process bound to
`127.0.0.1:${CALENDAR_GATEWAY_BIND_PORT:-8787}` by default. It has only two public contracts:

- `POST /eisenhower/google-calendar/webhook` proxies to n8n's fixed
  `/webhook/eisenhower-google-calendar` path.
- `GET /eisenhower/google-calendar/oauth/callback` proxies to the Node API's fixed
  `/calendar/oauth/callback` path and preserves the OAuth query string.

Every other path or method returns `404`. Access logging is disabled, authorization is stripped before
proxying, request bodies are bounded, and upstream connections have finite timeouts. Override
`CALENDAR_GATEWAY_N8N_UPSTREAM` or `CALENDAR_GATEWAY_API_UPSTREAM` to move either destination; do not
publish their private ports merely to relocate the gateway.

The Node API is the only service that receives `GOOGLE_CALENDAR_OAUTH_CLIENT_ID`,
`GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET`, `GOOGLE_CALENDAR_OAUTH_CALLBACK_URL` and
`GOOGLE_CALENDAR_OAUTH_ENCRYPTION_KEY`. `GOOGLE_CALENDAR_WATCH_CALLBACK_URLS` is an exact,
comma-separated HTTPS allowlist for watch delivery; n8n receives the matching public address as
`GOOGLE_CALENDAR_WEBHOOK_URL`. n8n receives no Google credential, token, calendar ID, tenant ID or
owner ID. Store all real values in the owner-only `.env`, never in Git.

The local n8n instance is deliberately operator-only and bound to loopback. Its repository-owned
Code nodes may read the deployment environment (`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`) so they can
sign internal requests and use the configured callback URL. Do not expose the n8n editor or allow
untrusted workflow authors on this deployment.

To add this gateway to an already configured Tailscale Funnel, first save the output of
`tailscale funnel status`. Do not use `tailscale funnel reset`: that would remove existing routes. With
the installed Tailscale version's current CLI, append a path mount equivalent to:

```bash
tailscale funnel --https=443 --set-path=/eisenhower/google-calendar --bg \
  http://127.0.0.1:8787/eisenhower/google-calendar
```

Then inspect `tailscale funnel status` again and confirm that all previous handlers are still present in
addition to `/eisenhower/google-calendar`. Set `GOOGLE_CALENDAR_OAUTH_CALLBACK_URL` to the resulting public
HTTPS callback ending in `/eisenhower/google-calendar/oauth/callback`. Treat editing Funnel as a
separate operator action: these deployment files neither run nor change Tailscale.

## Moving one component

On the destination host, start only the named service and set its `*_BIND_ADDRESS` to that host's real
private VPN/LAN address. On each caller, replace only the matching URL:

| Component moved | Destination bind | Caller URL |
| --- | --- | --- |
| Node API/outbox | `NODE_BIND_ADDRESS` | n8n: `EISENHOWER_INTERNAL_API_URL` |
| MongoDB | `MONGODB_BIND_ADDRESS` | Node/worker: `MONGODB_URI` |
| FastAPI | `AI_BIND_ADDRESS` | Node: `AI_SERVICE_URL` |
| Qdrant | `QDRANT_BIND_ADDRESS` | FastAPI/worker: `QDRANT_URL` |
| n8n | `N8N_BIND_ADDRESS` | operator/private callback routing |
| Calendar gateway | fixed `127.0.0.1`, configurable `CALENDAR_GATEWAY_BIND_PORT` | local Funnel target for the two fixed routes |
| Keycloak/PostgreSQL | no host port by default | access gateway `IDENTITY_UPSTREAM` |
| Remote MCP | no host port by default | access gateway `MCP_UPSTREAM` |
| Access gateway | fixed `127.0.0.1`, configurable `ACCESS_GATEWAY_BIND_PORT` | private Tailscale Serve target |
| vLLM | `INFERENCE_BIND_ADDRESS` | FastAPI: `INFERENCE_BASE_URL` and `INFERENCE_ALLOWED_HOSTS` |
| vLLM reranker | `RERANKER_BIND_ADDRESS` | FastAPI: `RERANKER_BASE_URL` and `RERANKER_ALLOWED_HOSTS` |

Never set a bind address to `0.0.0.0`. Private addressing alone is not an authorization boundary: enforce
host firewall/VPN ACLs, deny public ingress, rotate service credentials, and use TLS/mTLS when the private
transport is not already an explicitly approved encrypted mesh. MongoDB cross-host placement additionally
requires authenticated transport and a tested backup/restore plan before it is production-ready.

## Optional AMD inference contract

The AMD overlay also defines a separate `reranker-amd` profile for the default retrieval strategy.
It pins the evaluated `BAAI/bge-reranker-v2-m3` revision, served-model identity, FP16 dtype,
192-token context and authenticated score API. Start it independently from generation:

```bash
docker compose --env-file deploy/local/.env \
  -f deploy/local/compose.yaml -f deploy/local/compose.amd.yaml \
  --profile reranker-amd up reranker ai-service qdrant
```

The deployed default remains `hybrid-bge-v1` and therefore requires this service. `hybrid-rrf-v1` is a
separate no-reranker comparison candidate, not an automatic fallback or promoted default. It may be selected
only after the frozen holdout and human review preserve the configured quality thresholds; rollback remains
an explicit strategy/config revision. A missing, wrong or unavailable reranker never triggers a silent
strategy change.
The model cache defaults to `.runtime-cache/reranker-huggingface` on the workspace filesystem rather
than a Docker-root volume; override `RERANKER_MODEL_CACHE` when moving the service to another host.

Only after the separate generation physical ROCm gate selects the exact image digest, model/tokenizer revision, dtype or
quantization, context and concurrency, render the overlay:

```bash
docker compose --env-file deploy/local/.env \
  -f deploy/local/compose.yaml -f deploy/local/compose.amd.yaml \
  --profile inference-amd config --quiet
```

Starting it is a separate, explicit operation and may download a large image/model. This repository
change deliberately does not run that operation. Live qualification must still prove model loading,
strict response contracts, PL/EN behavior, latency, VRAM/OOM recovery, restart/fallback behavior and
public-network denial as described in `docs/ai-rebuild/inference-portability.md`.

## Disabled MAG runtime contract

The classifier role declares the governed memory runtime but keeps `MEMORY_WRITE_ENABLED`,
`MEMORY_RETRIEVAL_ENABLED` and `MEMORY_RESPONSE_ENABLED` false by default. Its read-only policy mount is
safe to render while disabled. Enabling writes later additionally requires an owner-only
`MEMORY_CONSENT_HMAC_KEY` of at least 32 bytes, the mounted policy's independent deployment approval,
private MongoDB and a scoped `memory:write` identity. Retrieval also requires the separate configured
Qdrant memory collection and `memory:read` scope. Response augmentation remains fail-closed and is not
implemented by this contract.

The public boundary forwards `Idempotency-Key` for confirmed memory commands. It never accepts tenant or
user scope from the body. Do not set any memory flag true merely because Compose renders or the API tests
pass; real writes, retrieval shadow and response augmentation keep their separate consent and cohort gates.

## Contract verification

The lightweight check parses configuration only and does not pull or start images:

```bash
python3 -m unittest deploy/local/tests/test_local_production_contract.py
```
