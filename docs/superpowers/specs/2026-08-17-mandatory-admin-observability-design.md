# Mandatory admin automation and observability

## Decision

n8n, Prometheus and Grafana are mandatory members of the canonical `compose.yaml`
graph in development and production. They have no host ports. Their administrative
interfaces are reachable only through the existing gateway after Keycloak login by a
user holding the `eisenhower-admin` realm role.

The Google Calendar webhook remains the sole unauthenticated n8n-facing gateway route.
It is not an administrative interface and retains its existing method restriction and
application-level provider/HMAC validation. No Prometheus scrape endpoint or raw
service port is published by the gateway.

## Architecture

The canonical graph adds mandatory Prometheus, Grafana and an OIDC authorization proxy.
n8n loses its Compose profile and is always started. The authorization proxy is a
supporting private service which performs the browser OIDC code flow against the
existing Keycloak realm, creates secure gateway-scoped sessions and admits only the
`eisenhower-admin` role.

The gateway remains the only service with a host port and routes:

- `/admin/n8n/` to the n8n editor;
- `/admin/prometheus/` to the Prometheus UI;
- `/admin/grafana/` to Grafana;
- `/oauth2/` to the private authorization proxy for login and callback handling;
- `/eisenhower/google-calendar/webhook` directly to the n8n production webhook,
  outside the admin browser session but under its existing narrow transport contract.

Each `/admin/` route uses nginx `auth_request`. A missing, expired or unauthorized
session initiates or rejects authentication without forwarding the request upstream.
The proxy accepts only the exact configured issuer, client and redirect URL, uses secure
cookies, does not trust arbitrary forwarded headers, and checks the realm-role claim for
`eisenhower-admin`.

Grafana and n8n are configured for their gateway subpaths. Prometheus receives an
external URL and route prefix matching `/admin/prometheus/`. Direct container-network
access remains an infrastructure trust boundary and is not exposed to the host.

## Identity contract

The imported Keycloak realm declares the `eisenhower-admin` realm role and a confidential
`eisenhower-admin-access` client dedicated to the authorization proxy. Its redirect URI
is the exact gateway `/oauth2/callback` URL. The client secret is supplied at runtime as
`ADMIN_OIDC_CLIENT_SECRET`; it is never stored in the realm export or repository.

Ordinary Eisenhower users do not receive the admin role. Existing task, Calendar and MCP
roles/scopes remain unchanged. Removing an administrator's role or expiring their OIDC
session prevents subsequent administrative requests; no long-lived gateway credential
is introduced.

## Service and readiness contract

All three requested services are unconditional. The canonical Compose graph contains no
`n8n`, `observability` or equivalent opt-in profile, and generic deployment has no enable
switch. `docker compose up --wait` must fail when n8n, Prometheus or Grafana is unhealthy.

Healthchecks exercise the services' private health/readiness endpoints. Gateway startup
depends on healthy n8n, Prometheus, Grafana and authorization proxy services, in addition
to its existing dependencies. The application CRUD boundary remains independently
implemented, but an unhealthy mandatory administrative service makes the deployment as
a whole unacceptable.

Prometheus scrapes the private AI boundary, knowledge runtime, Qdrant and its own process.
Private inference is an external provider stack, so its target may be absent only when
generation is disabled; the existing alert expresses this distinction. Metrics remain
aggregate and must not use tenant, user, prompt, document, token or memory content as
labels.

## Persistence, backup and restore

n8n keeps its existing durable volume. Grafana receives a durable data volume and
provisioned, read-only dashboard definitions from `monitoring/grafana`. Prometheus
receives a durable volume with an explicit bounded retention time and size.

Generic backup and restore include n8n and Grafana state. Prometheus time-series data is
operational and noncanonical: it is recreated after loss and is not added to the canonical
backup set. Prometheus configuration, alert rules and Grafana provisioning remain
versioned source artifacts.

## Deployment and rollback

The deployment workflow removes `enable_n8n`; generic deployment always renders and
starts the same graph. The active deployment state no longer stores an n8n profile flag,
and rollback always restores the previous immutable image manifest using the mandatory
graph.

Release publication remains responsible only for first-party application images. Pinned
third-party images for n8n, Prometheus, Grafana and the authorization proxy are deployment
inputs and must be qualified and preferably digest-pinned before production acceptance.
No provider-specific deployment is reintroduced.

## Verification design

Strict TDD begins with executable contracts that fail against the current optional graph:

1. Rendered dev and prod graphs contain unconditional n8n, Prometheus, Grafana and the
   authorization proxy, with only the gateway publishing a host port.
2. Removing any mandatory service or adding a profile fails the graph contract.
3. Gateway integration tests prove anonymous and ordinary-user admin requests are denied,
   an administrator is forwarded, and the Calendar webhook remains the only public n8n
   route.
4. The Keycloak realm contract proves the dedicated client, exact redirect and admin role
   without embedding its secret.
5. Deployment and rollback tests prove there is no optional n8n input or profile state and
   that rollback starts the same mandatory graph.
6. Monitoring contracts validate scrape targets, dashboard provisioning, bounded
   retention, healthchecks and private networking.
7. Backup/restore tests prove n8n and Grafana are included and Prometheus is deliberately
   excluded as rebuildable telemetry.

Focused contracts are followed by safe dev/prod Compose renders, provider-stack renders,
Node gateway/deployment tests, FastAPI metrics tests, n8n workflow contracts, generic
lifecycle tests, workflow YAML/actionlint, shell validation and `git diff --check`.

Local configuration and tests do not prove a live Keycloak login, imported active n8n
workflow, delivered alert, retained time series, restored Grafana state, public HTTPS or
production administrator acceptance. Those remain target-runtime gates.
