# Production acceptance

Last reviewed: 2026-08-17

This checklist separates local source verification, release publication, target deployment,
public behavior, and human or physical acceptance. Passing one level never implies another.

## Local candidate

A candidate worktree is locally acceptable when:

- `make verify`, the Compose contract tests, release workflow contract tests, and
  generic backup/restore/rollback tests pass from a clean dependency install;
- `compose.yaml` renders with safe placeholders for both development and production,
  with the same service graph and only `gateway` publishing host ports;
- n8n, Prometheus and Grafana are mandatory, private and health-gated; their consoles
  are routed only at `/admin/n8n/`, `/admin/prometheus/` and `/admin/grafana/` after
  OAuth2 Proxy confirms the Keycloak `eisenhower-admin` realm role;
- `APP_ENV` and `AUTH_MODE` are explicit and validated, and production accepts only OIDC;
- the three application-facing inference variables are exactly `INFERENCE_BASE_URL`,
  `INFERENCE_API_KEY`, and `INFERENCE_ALLOWED_HOSTS`;
- the AMD and NVIDIA inference stacks render independently of the application topology;
- Calendar internal HTTP requests bind timestamp, request ID, method, path and exact raw
  body into HMAC, and a durable unique receipt makes replays idempotent or rejects them;
- OCR rejects invalid or over-limit dimensions/pixel counts before decoding for OCR;
- `git diff --check`, shell validation, type checking, and workflow YAML parsing pass.

Local tests do not prove that an image was built, scanned, published, pulled, started, or
accepted by a person.

## Release candidate

The manually dispatched release retains the existing full-green-master-SHA preflight. It
must validate the full SHA, prove ancestry from `origin/master`, find the exact successful
master push run, and recheck all stable CI contexts before any secret-bearing job runs.

The release workflow builds every first-party image, scans it, creates an SBOM, publishes
immutable registry digests, and emits a checksum-protected release manifest. The final gate
binds that container manifest and the verified release APK to the same SHA. A mutable tag,
green source CI alone, or a locally rendered Compose file is not a released artifact.

Provider-specific deployment is not part of release. The historical AWS ECS force-redeploy
was removed because it restarted the currently configured task definition without proving
that it contained the requested SHA or digest.

## Generic target deployment

`.github/workflows/deploy.yml` consumes a selected release-run manifest. The generic deploy
script uses only manifest digests, forces `APP_ENV=production` and `AUTH_MODE=oidc`, waits for
readiness, and checks each first-party container's OCI revision label against the release SHA.
On failure it restores the previous immutable manifest and topology.

Before target acceptance, operators must independently prove:

- secret provisioning, target TLS, DNS, storage capacity and network policy;
- live backup and confirmation-gated restore on representative data;
- rollback after a deliberately failed rollout;
- live Keycloak login for a named user with `eisenhower-admin`, plus rejection of an
  unauthenticated user and an authenticated user without that role;
- imported and active n8n workflows plus successful execution history;
- healthy Prometheus targets/rules, populated Grafana dashboards and alert delivery;
- provider-specific AMD or NVIDIA runtime health and model quality where inference is enabled.

## Public and physical acceptance

The deployed SHA is publicly accepted only after exact-status HTTPS checks prove gateway,
API and AI readiness; unauthenticated access fails closed; OIDC user CRUD and authorization
boundaries work; `POST /eisenhower/google-calendar/webhook` is the only public n8n route;
and browser requests have no mixed content. Physical Android installation and end-to-end
use, plus any required human model evaluation, remain separate gates.

## Backup scope

`deploy/generic/backup.sh` archives MongoDB and the durable audit, identity, n8n, Grafana and
RAG job volumes with checksums and the active release manifest. `restore.sh` requires an
explicit confirmation. Prometheus retention data is operational and is rebuilt from live
scrape targets after restore. Qdrant is rebuildable from canonical MongoDB data and is
intentionally not a canonical backup source.

## Architecture, transport and methodology

- CSRF: product API credentials are Bearer tokens rather than cookies, CORS credentials
  remain disabled, and unsafe untrusted origins are rejected. Admin console access adds a
  secure SameSite=Lax OAuth2 Proxy session cookie; the gateway's Origin allowlist rejects
  cross-site unsafe requests, while n8n and Grafana retain their own request protections.
  CORS and Origin checks are defense in depth, not authentication.
- HTTP/webhooks: the gateway is the only ingress. MongoDB, Qdrant, API/AI, MCP and n8n stay
  private, as do Prometheus, Grafana and OAuth2 Proxy. Only explicit Calendar OAuth and
  webhook routes proxy publicly to n8n/API contracts; admin routes require the role gate.
- Messaging/outbox: Calendar retains its durable outbox claim/lease/ack semantics. The replay
  receipt and claim mutation are atomic for `/outbox/claim`; n8n reuses one request ID across
  HTTP retries. No general-purpose message bus is claimed.
- DDD: this is a pragmatic layered monorepo with useful domain language and boundaries, not
  proven repository-wide DDD with formal bounded contexts and aggregate discipline.
- CQRS and hexagonal architecture: task commands and reads are separated at application ports
  in useful areas, and provider adapters are bounded, but there is no independent CQRS read
  model or strict repository-wide ports-and-adapters architecture.
- TDD: the new behavior has recorded red-green-refactor evidence. Existing tests alone do not
  prove historical repository-wide TDD practice.
- BDD: executable Cucumber scenarios cover the supported task lifecycle and security behavior.
  The new deployment, HMAC replay and OCR protections are covered by contract/unit tests, not
  new Gherkin scenarios, so repository-wide BDD is not claimed.

## Dependency exception

Backend Node and web production audits must report zero high or critical vulnerabilities.
The time-bounded Expo/Metro `image-size` exception remains governed by the existing
`npm run audit:production` policy and must not be generalized to release images.

## Go/no-go

Until release artifacts exist and the target, public, backup/restore, n8n, provider, Android
and human gates relevant to a deployment pass on the same SHA, the correct status is
"locally verified release candidate", not "deployed" or "production ready".
