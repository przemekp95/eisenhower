# Mandatory Admin Automation and Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make n8n, Prometheus, and Grafana mandatory parts of the canonical Compose graph, with every UI reachable only through the single gateway after a Keycloak `eisenhower-admin` role check.

**Architecture:** The canonical `compose.yaml` contains all three applications plus a private OAuth2 Proxy policy-enforcement service. Nginx remains the only host-published ingress, delegates `/admin/*` authorization to OAuth2 Proxy through `auth_request`, and keeps only the existing narrow Calendar/n8n webhook public. Keycloak remains the identity provider; Grafana and n8n retain their own application state, while Prometheus data is bounded and rebuildable.

**Tech Stack:** Docker Compose, Nginx, Keycloak, OAuth2 Proxy 7.12, n8n 2.4.6, Prometheus 3.5, Grafana 12.1, Python `unittest`, shell lifecycle tests, GitHub Actions.

## Global Constraints

- Work only in `/home/przemekp95/.codex/worktrees/8101/eisenhower`; do not stash or touch the dirty primary checkout.
- Preserve one canonical `compose.yaml`, one host-published gateway port, and identical service graphs for dev and prod renders.
- Keep Mongo, Qdrant, APIs, identity, n8n, Prometheus, Grafana, and OAuth2 Proxy private.
- Treat `eisenhower-admin` as a new dedicated Keycloak realm role; do not reinterpret the existing application `admin` role.
- Keep `/webhook/calendar/*` public and narrow. Do not expose general n8n webhook, editor, metrics, or admin paths without authorization.
- Apply strict TDD to behavioral changes: add a focused failing test, capture the failure, implement the smallest change, rerun green, then refactor.
- Stop before merge, push, image publication, deployment, cutover, or production mutation.

---

## Task 1: Lock the mandatory topology and admin boundary with red contract tests

**Files:**

- Modify: `deploy/tests/test_compose_contract.py`
- Create: `deploy/tests/test_admin_access_contract.py`
- Modify: `backend-ai/tests/test_monitoring_contract.py`

- [ ] Add Compose assertions that `n8n`, `prometheus`, `grafana`, and `oauth2-proxy` are present without profiles in both dev and prod renders.
- [ ] Extend the private-service set so none of those four services has `ports`, `network_mode: host`, or a published host binding.
- [ ] Assert the only service with a host port remains `gateway` and its dependencies include the mandatory admin stack.
- [ ] Assert dev and prod renders have an identical service/dependency graph and that the three application services have healthchecks.
- [ ] Add gateway-policy tests that require protected `/admin/n8n/`, `/admin/prometheus/`, and `/admin/grafana/` routes, a private `/oauth2/auth` subrequest, and the explicit public Calendar webhook exception.
- [ ] Add identity-policy tests that require the realm role `eisenhower-admin` and confidential client `eisenhower-admin-access` with the expected redirect URI.
- [ ] Extend monitoring contracts to require Prometheus to scrape itself plus application metrics and to load the checked-in alert rules.
- [ ] Run the focused tests and record RED because the three mandatory services and admin policy do not yet exist:

```bash
python3 -m unittest \
  deploy.tests.test_compose_contract \
  deploy.tests.test_admin_access_contract \
  backend-ai.tests.test_monitoring_contract -v
```

- [ ] Commit only the red tests:

```bash
git add deploy/tests/test_compose_contract.py deploy/tests/test_admin_access_contract.py backend-ai/tests/test_monitoring_contract.py
git commit -m "test: require mandatory admin observability"
```

## Task 2: Implement the mandatory private services and role-gated gateway

**Files:**

- Modify: `compose.yaml`
- Modify: `deploy/local/access-gateway.conf.template`
- Modify: `deploy/local/identity/eisenhower-realm.json`
- Create: `monitoring/grafana/provisioning/datasources/prometheus.yml`
- Create: `monitoring/grafana/provisioning/dashboards/default.yml`
- Modify: `.env.example`
- Modify: `deploy/env/dev.env.example`
- Modify: `deploy/env/prod.env.example`

- [ ] Remove the n8n profile and add a healthcheck. Configure its editor base path as `/admin/n8n/` while retaining the existing public Calendar webhook URL contract.
- [ ] Add private mandatory `prometheus` using `prom/prometheus:v3.5.0`, the checked-in scrape/rule configuration, bounded retention, persistent storage, `--web.external-url=/admin/prometheus/`, and a readiness healthcheck.
- [ ] Add private mandatory `grafana` using `grafana/grafana:12.1.0`, persistent storage, provisioned Prometheus datasource/dashboard, `/admin/grafana/` subpath settings, disabled anonymous/login-form access, and a healthcheck.
- [ ] Add private mandatory `oauth2-proxy` using `quay.io/oauth2-proxy/oauth2-proxy:v7.12.0-alpine`, Keycloak OIDC, `--allowed-role=eisenhower-admin`, secure cookies, `--set-xauthrequest=true`, a static success upstream, and a ping healthcheck.
- [ ] Pass `ADMIN_OIDC_CLIENT_SECRET` and `ADMIN_OIDC_REDIRECT_URI` into the Keycloak import environment. Add the `eisenhower-admin` realm role and confidential `eisenhower-admin-access` client without changing existing roles or clients.
- [ ] Make gateway startup depend on healthy n8n, Prometheus, Grafana, and OAuth2 Proxy.
- [ ] Add Nginx upstreams and routes. For each `/admin/*` route, require `auth_request /oauth2/auth`, redirect 401 responses to `/oauth2/start`, propagate the authenticated user header, and proxy to the matching private service. Keep only `/webhook/calendar/*` outside the admin gate.
- [ ] Add required safe-placeholder environment variables to all examples:

```dotenv
ADMIN_OIDC_CLIENT_SECRET=replace-with-random-confidential-client-secret
ADMIN_OIDC_COOKIE_SECRET=replace-with-32-byte-base64-cookie-secret
ADMIN_OIDC_REDIRECT_URI=https://eisenhower.example.test/oauth2/callback
PROMETHEUS_RETENTION_TIME=15d
```

- [ ] Render both environments with non-secret placeholders and validate Nginx and OAuth2 Proxy configuration inside their pinned images:

```bash
python3 deploy/tests/render_compose.py --environment dev
python3 deploy/tests/render_compose.py --environment prod
docker compose --env-file deploy/env/dev.env.example config >/tmp/eisenhower-compose-dev.yaml
docker compose --env-file deploy/env/prod.env.example config >/tmp/eisenhower-compose-prod.yaml
docker run --rm quay.io/oauth2-proxy/oauth2-proxy:v7.12.0-alpine --version
```

- [ ] Rerun Task 1 tests and record GREEN, then simplify repeated assertions/helpers without weakening behavior.
- [ ] Commit the green implementation:

```bash
git add compose.yaml deploy/local/access-gateway.conf.template deploy/local/identity/eisenhower-realm.json monitoring/grafana .env.example deploy/env/dev.env.example deploy/env/prod.env.example
git commit -m "feat: require role-gated admin services"
```

## Task 3: Remove optional-profile drift from generic deploy and protect state

**Files:**

- Modify: `deploy/tests/test_generic_lifecycle.py`
- Modify: `.github/workflows/deploy.yml`
- Modify: `deploy/generic/deploy.sh`
- Modify: `deploy/generic/rollback.sh`
- Modify: `deploy/generic/backup.sh`
- Modify: `deploy/generic/restore.sh`
- Modify: `deploy/README.md`

- [ ] Change lifecycle tests first: deploy accepts only environment and digest manifest, never an `enable_n8n` flag; deploy/rollback never write/read an active-profile marker; all mandatory services participate in `up --wait`; backup/restore includes n8n and Grafana state; Prometheus is explicitly excluded as rebuildable operational data.
- [ ] Run the focused lifecycle suite and record RED against the current profile-aware scripts:

```bash
python3 -m unittest deploy.tests.test_generic_lifecycle -v
```

- [ ] Remove the `enable_n8n` workflow input and every `--profile n8n` branch or profile state file from deploy and rollback.
- [ ] Preserve exact-digest deployment and rollback semantics while making the canonical graph unconditional.
- [ ] Add Grafana to backup/restore targets and keep n8n included. Document that Prometheus retention data is not a business backup and is reconstructed from live metrics after restore.
- [ ] Rerun lifecycle tests GREEN, then run shell syntax checks:

```bash
bash -n deploy/generic/deploy.sh deploy/generic/rollback.sh deploy/generic/backup.sh deploy/generic/restore.sh
python3 -m unittest deploy.tests.test_generic_lifecycle -v
```

- [ ] Commit the lifecycle migration:

```bash
git add deploy/tests/test_generic_lifecycle.py .github/workflows/deploy.yml deploy/generic deploy/README.md
git commit -m "refactor: make admin stack unconditional"
```

## Task 4: Align documentation, release audit, and operational acceptance

**Files:**

- Modify: `README.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/PRODUCTION_ACCEPTANCE.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/OPERATIONS_RUNBOOK.md`
- Modify: `docs/architecture/deployment-topology.md`
- Modify: `deploy/tests/test_docs_contract.py`
- Modify: `deploy/tests/test_workflow_contract.py`

- [ ] Add failing documentation/workflow contracts that reject descriptions of n8n as optional, reject provider-specific deploy jobs, require the three admin paths and `eisenhower-admin`, and keep the final release gate separate from generic deployment.
- [ ] Run those focused tests and record RED:

```bash
python3 -m unittest deploy.tests.test_docs_contract deploy.tests.test_workflow_contract -v
```

- [ ] Update the topology and operational docs to describe mandatory services, admin-only routes, public Calendar webhook exception, first-admin role assignment, secret rotation, backup/restore scope, Prometheus retention, and outage behavior.
- [ ] State evidence boundaries explicitly: source/configuration and local tests do not prove live Keycloak login, n8n activation/execution, metric ingestion, alert delivery, public TLS, restore on real volumes, or production cutover.
- [ ] Preserve release policy: only first-party immutable application artifacts are built/scanned/published by release; third-party images are pinned deployment inputs; provider-specific inference deployment stays outside release and generic deploy.
- [ ] Rerun the docs/workflow contracts GREEN and refactor duplicate prose.
- [ ] Commit documentation and audit alignment:

```bash
git add README.md docs deploy/tests/test_docs_contract.py deploy/tests/test_workflow_contract.py
git commit -m "docs: document mandatory admin operations"
```

## Task 5: Full verification, TaskPlanner closure, and handoff

**Files:**

- Modify: `.tasks/IN_PROGRESS.md`
- Modify: `.tasks/DONE.md`
- Modify: `.tasks/WORK_LOG.md`

- [ ] Run Compose graph, gateway, monitoring, lifecycle, docs, and workflow tests together.
- [ ] Run the repository-prescribed Node/MCP/FastAPI/n8n/BDD suites proportional to the changed boundaries, plus backup/restore/rollback tests.
- [ ] Render canonical Compose for dev and prod using safe placeholders, compare the normalized service/dependency graph, and run `docker compose config --quiet` for both.
- [ ] Run workflow syntax/lint validation and verify release still consumes the existing full-green-master-SHA gate without reimplementing it.
- [ ] Inspect `git diff --check`, the final diff, status, and commit history. Record exact pass/fail/skip counts and all environment-dependent gaps.
- [ ] Move TASK-063 from In Progress to Done only if every locally executable gate is green; add a newest-first work-log entry with the verified commit SHA and evidence boundary.
- [ ] Commit TaskPlanner closure:

```bash
git add .tasks/IN_PROGRESS.md .tasks/DONE.md .tasks/WORK_LOG.md
git commit -m "chore: close mandatory admin observability task"
```

- [ ] Stop with a clean, verified branch. Do not merge, push, publish images, deploy, or alter production.
- [ ] Report remaining physical/production gates: assign the Keycloak admin role to a real user, complete live OIDC login, verify unauthorized/authorized routing, activate and execute Calendar workflows on the deployed n8n version, observe Prometheus targets/rules and Grafana dashboards, exercise alert delivery, rehearse real-volume restore/rollback, and validate public HTTPS/cutover.
