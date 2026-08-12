# Local production topology

This topology runs the application on one local Linux host by default and keeps every location-sensitive
connection configurable. The initial target is the AMD computer, but Node/Mongo, FastAPI, Qdrant, n8n
and inference can be moved independently to hosts reachable over a private LAN/VPN address.

## What is deployable now

`compose.yaml` contains only real entrypoints: Node API, a single-node MongoDB replica set required by
the transactional outbox, FastAPI, the existing RAG worker,
Qdrant and n8n. The Mongo outbox publisher is part of the Node API process; there is intentionally no
invented `outbox-worker` container. The current MCP entrypoint is stdio-only, so this topology does not
pretend that a remotely deployable MCP HTTP service exists.

`compose.amd.yaml` is an opt-in vLLM/ROCm overlay. It is a deployment contract, not evidence that vLLM
or a model works on this AMD host. It has no readiness check because no live model was loaded or tested.
FastAPI remains usable with generation disabled and its MiniLM fallback.

## First same-host deployment

1. Build and tag the Node and AI images locally for one exact Git SHA (or publish them to the registry).
   Set `API_IMAGE` and `AI_IMAGE` to those versioned tags or, preferably after publication, registry
   digests. Do not use mutable `latest` tags.

   ```bash
   release_sha="$(git rev-parse HEAD)"
   docker build --target production -f backend-node/Dockerfile \
     -t "local/eisenhower-api:${release_sha}" .
   docker build --target production -f backend-ai/Dockerfile \
     -t "local/eisenhower-ai:${release_sha}" backend-ai
   ```
2. Copy `.env.example` to `.env`, replace the placeholder image tags and populate secrets. Keep `.env`
   outside version control and readable only by its owner. `AI_EVALUATION_FILE` must be the absolute host
   path to an owner-approved production evaluation artifact; its approved digest is a separate required
   input. A development benchmark is not a production substitute.
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

This binds host ports to `127.0.0.1` by default. Compose DNS names provide same-host service-to-service
URLs. A reverse proxy or private client may reach only the endpoints explicitly selected by the owner.

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
| vLLM | `INFERENCE_BIND_ADDRESS` | FastAPI: `INFERENCE_BASE_URL` and `INFERENCE_ALLOWED_HOSTS` |

Never set a bind address to `0.0.0.0`. Private addressing alone is not an authorization boundary: enforce
host firewall/VPN ACLs, deny public ingress, rotate service credentials, and use TLS/mTLS when the private
transport is not already an explicitly approved encrypted mesh. MongoDB cross-host placement additionally
requires authenticated transport and a tested backup/restore plan before it is production-ready.

## Optional AMD inference contract

Only after the physical ROCm gate selects the exact image digest, model/tokenizer revision, dtype or
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
