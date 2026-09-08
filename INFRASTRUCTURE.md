# Infrastructure

## Canonical topology

`compose.yaml` is the only application Compose manifest. Development and
production render the same services, dependencies, volumes and networks;
`APP_ENV`, `AUTH_MODE`, image references and secrets are environment inputs.
Production is fail-closed to `APP_ENV=production` plus `AUTH_MODE=oidc`.

Only `gateway` publishes a host port. MongoDB, Qdrant, Node, every FastAPI role,
MCP and n8n remain private. The gateway exposes the web application, explicit
API/AI/MCP/identity paths, the Calendar OAuth callback, and the single Calendar
webhook. n8n is enabled only by the `n8n` profile.

MongoDB is canonical. Qdrant is a rebuildable projection. Calendar state
changes and the outbox remain transactional in Node; n8n performs private
provider orchestration and never owns canonical state.

## Provider boundary

`deploy/inference/compose.amd.yaml` and `compose.nvidia.yaml` are standalone
provider projects joined to the private application network. Model, runtime and
hardware variables stay inside those projects. Application services consume
only:

- `INFERENCE_BASE_URL`
- `INFERENCE_API_KEY`
- `INFERENCE_ALLOWED_HOSTS`

Provider qualification and physical GPU evidence are independent from an
application release or deployment.

## CI, release and deploy

- `.github/workflows/ci.yml` validates source and preserves stable required jobs.
- `.github/workflows/release.yml` preserves the exact-green-master-SHA preflight,
  builds/scans all first-party images, then publishes them only behind one
  aggregate job and emits a SHA-to-RepoDigest/security-evidence manifest.
- `.github/workflows/deploy.yml` is a separately authorized generic deployment
  that consumes only that manifest.

`deploy/generic/deploy.sh` renders the canonical graph with digest-bound images,
waits for health, verifies OCI source labels and performs immutable-manifest
rollback on failure. `backup.sh`/`restore.sh` checksum canonical Mongo and
private state volumes. Qdrant uses its separately governed snapshot/reindex
path because it is rebuildable.

The former AWS action was removed because forcing the current ECS task
definition did not bind the requested SHA or digest and therefore was not
deployment evidence. No provider-specific deploy job is part of release.

## Evidence boundary

Compose rendering, tests, CI, image scans, a release manifest and local runtime
health are separate evidence layers. None alone proves an authorized deploy,
public production, real n8n activation/execution, physical GPU compatibility or
human acceptance.
