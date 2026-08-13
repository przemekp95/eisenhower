# Local production topology

This topology runs the application on one local Linux host by default and keeps every location-sensitive
connection configurable. The initial target is the AMD computer, but Node/Mongo, FastAPI, Qdrant, n8n
the calendar/access gateways, identity service, Remote MCP and inference can be moved independently to hosts reachable over a private
LAN/VPN address.

## What is deployable now

`compose.yaml` contains only real entrypoints: the web UI, Node API, a single-node MongoDB replica set required by
the transactional outbox, FastAPI, the existing RAG worker,
Qdrant, n8n, Keycloak with PostgreSQL, the OAuth-protected Remote MCP adapter and narrow nginx gateways. The Mongo outbox publisher is part of the Node API process; there is intentionally no
invented `outbox-worker` container. A one-shot `audit-volume-init` applies the shared audit directory and
preserves the distinct UID ownership required by the Node/MCP and AI audit files
by the non-root Node container before it starts. Production is fixed to `AUTH_MODE=oidc`; neither Node,
FastAPI nor Remote MCP receives a static user token as a fallback.

`compose.amd.yaml` is an opt-in vLLM/ROCm overlay with independently movable BGE-M3 retrieval,
Qwen generation and BGE reranking services. The exact local matrix and its readiness checks have physical
qualification evidence under `backend-ai/evaluation/`; response exposure still remains independently
fail-closed. FastAPI keeps its deterministic classifier fallback when private generation is unavailable.

## First same-host deployment

1. Build and tag the Node, CPU/ROCm AI, MCP and web images locally for one exact Git SHA (or publish them to the registry).
   Set `API_IMAGE`, `AI_IMAGE`, `AI_ROCM_IMAGE`, `MCP_IMAGE` and `WEB_IMAGE` to those versioned tags or, preferably after publication, registry
   digests. Do not use mutable `latest` tags.

   ```bash
   release_sha="$(git rev-parse HEAD)"
   docker build --target production -f backend-node/Dockerfile \
     -t "local/eisenhower-api:${release_sha}" .
   docker build --target production -f backend-ai/Dockerfile \
     -t "local/eisenhower-ai:${release_sha}" backend-ai
   docker build -f mcp/eisenhower_adapter/Dockerfile \
     -t "local/eisenhower-mcp:${release_sha}" .
   docker build --target production -f web/Dockerfile \
     -t "local/eisenhower-web:${release_sha}" .
   ```
2. Copy `.env.example` to `.env`, replace the placeholder image tags and populate secrets. Keep `.env`
   outside version control and readable only by its owner. `AI_EVALUATION_FILE` must be the absolute host
   path to an owner-approved production evaluation artifact; its approved digest is a separate required
   input. A development benchmark is not a production substitute. A direct owner decision may temporarily
   accept the missing independent-human artifact by setting `LOCAL_MODEL_OWNER_APPROVAL_VALID_UNTIL` to a
   timezone-aware ISO-8601 deadline. This is recorded as an evidence bypass rather than fabricated evaluation
   data, and classifier requests fail closed automatically after the deadline. If responses are enabled,
   `AI_PROMOTION_ROOT` must contain the controller-written `current.json`, and
   `RAG_RESPONSE_CANDIDATE_ID` must match its response candidate. The pointer is mounted read-only;
   expiry or corruption automatically returns fallback without a container restart.
3. Render without pulling or starting containers:

   ```bash
   docker compose --env-file deploy/local/.env \
     -f deploy/local/compose.yaml config --quiet
   ```

4. Start the CPU-safe topology and verify each real endpoint from the host:

   ```bash
   docker compose --env-file deploy/local/.env \
     -f deploy/local/compose.yaml up -d
   docker compose --env-file deploy/local/.env \
     -f deploy/local/compose.yaml ps
   ```

For the independently governed AMD knowledge-answer canary, use `deploy.sh deploy-response`.
It builds and starts only the knowledge runtime plus the private gateway and does not weaken or
reuse the classifier's separate 240-case production-evaluation gate. The service exposes only the
answer route, liveness and aggregate metrics; the atomic pointer, candidate ID, tenant/user
allowlists and inference/reranker credentials are all mandatory.

This binds host ports to `127.0.0.1` by default. Compose DNS names provide same-host service-to-service
URLs. A reverse proxy or private client may reach only the endpoints explicitly selected by the owner.

For a repeatable exact-SHA AMD preparation and rollout, keep `deploy/local/.env` mode `0600` and use:

```bash
deploy/local/deploy.sh render
deploy/local/deploy.sh build
deploy/local/deploy.sh deploy
deploy/local/deploy.sh smoke
```

The full `deploy` action starts infrastructure first, then the independently bounded GPU inference/reranker
and knowledge runtime, the CPU classifier plus API/web/MCP, and finally both gateways. This prevents the web
gateway from becoming healthy before its UI upstream exists and avoids loading a second BGE retrieval model
into GPU memory for the ordinary classifier. The script refuses a dirty index/worktree, derives every first-party image tag from `HEAD`, verifies the
OCI revision label and records the pre-deploy container image IDs in the owner-only
`.runtime-cache/local-deploy/rollback.env`. It renders all three AMD profiles before mutation. A missing
production evaluation artifact remains a hard preflight failure unless an unexpired owner deadline is present;
a missing model revision or service key always fails preflight.

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

`RAG_RETRIEVAL_ENABLED=true` now requires this service unless the operator explicitly selects the
`dense-v1` rollback. A missing, wrong or unavailable reranker never triggers a silent dense fallback.
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

## Contract verification

The lightweight check parses configuration only and does not pull or start images:

```bash
python3 -m unittest deploy/local/tests/test_local_production_contract.py
```
