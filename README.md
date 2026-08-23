# Eisenhower Matrix

<!-- TASKPLANNER:ATTRIBUTION:START -->
This project uses [TaskPlanner](https://github.com/smekai/taskplanner) for task planning.
<!-- TASKPLANNER:ATTRIBUTION:END -->

Monorepo for the Eisenhower Matrix application with a React web client, a Node/Express API, a FastAPI AI service, and an Expo mobile client.

## Branch Flow

- `feature/* -> dev`
- `dev -> master`
- every merge to `master` automatically fast-forwards `dev` to the same commit SHA when `dev` has not advanced independently
- if `dev` moves ahead before that fast-forward lands, the repository falls back to the technical sync PR `master -> dev`
- `master` remains the default branch
- `dev` and `master` are protected with GitHub rulesets

The automatic fast-forward uses a dedicated repository deploy key (`DEV_SYNC_DEPLOY_KEY`) so GitHub Actions can update the protected `dev` branch without broadening admin bypass access.
That fast-forward waits for the complete required gate set, including integration, browser E2E, and the native Android release build, before `dev` and `master` reconverge on the same SHA.
When that post-release fast-forward lands on `dev`, the follow-up `push` run in `ci.yml` now stays in a lightweight mode check instead of replaying the full CI matrix for a commit SHA that already passed on `master`.

Pull requests into `master` are allowed only from `dev`. While the repository has a single maintainer, the required approval count remains `0`, but pull requests and passing checks are mandatory.

## Services

- `web`: React + Vite frontend for task CRUD and AI tools
- `backend-node`: REST API for tasks and health checks
- `backend-ai`: FastAPI service for classification, OCR, and batch analysis
- `mobile/eisenhower-matrix`: Expo / React Native client
- `qdrant`: private rebuildable projection for canonical RAG data
- `n8n`: mandatory private automation runtime; only the explicit Calendar webhook is routed publicly
- `prometheus`: mandatory private metrics and alert-rule runtime
- `grafana`: mandatory private operational dashboard runtime

Plain-language browser instructions are available in [`docs/WEB_GUIDE.md`](docs/WEB_GUIDE.md).

## Runtime Configuration

### Web

- `VITE_API_URL`: Node API base URL, default `http://localhost:3001`
- `VITE_AI_API_URL`: AI service base URL, default `http://localhost:8000`
- Production `web` image generates `/runtime-config.js` at container startup, so `VITE_*` values can be changed without rebuilding the image.
- The production entrypoint also versions the `/runtime-config.js` URL at startup and serves that file with `no-store`, so CDN caches do not pin stale backend URLs.
- Production deploys can use relative `VITE_API_URL=/api` and `VITE_AI_API_URL=/ai` when the frontend reverse proxies both backends over the same HTTPS origin.

### Backend Node

- `PORT`: HTTP port, default `3001`
- `MONGODB_URI`: MongoDB connection string
- `AI_SERVICE_URL`: AI backend base URL
- `EISENHOWER_API_TOKEN`: required Bearer token; production values must contain at least 32 characters
- `CORS_ALLOW_ORIGINS`: comma-separated explicit browser origins; production requires the public frontend origin, including same-origin deployments

### Backend AI

- `TRAINING_DATA_PATH`: path to the training examples file
- `MODEL_CACHE_DIR`: directory used for model and cache artifacts
- `LOCAL_MODEL_NAME`: sentence-transformer used as the frozen encoder, default `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`
- `LOCAL_MODEL_EPOCHS`: max epochs for explicit retraining, default `60`
- `LOCAL_MODEL_PATIENCE`: early-stopping patience for explicit retraining, default `8`
- `LOCAL_MODEL_HIDDEN_DIM`: hidden layer width for the classification head, default `128`
- `LOCAL_MODEL_DROPOUT`: dropout for the classification head, default `0.1`
- `LOCAL_MODEL_LEARNING_RATE`: optimizer learning rate for the classification head, default `0.01`
- `EVALUATION_DATA_PATH`: standalone PL/EN classifier evaluation set, default `backend-ai/data/evaluation_v1.json`
- `LOCAL_MODEL_CONFIDENCE_THRESHOLD`: calibrated-confidence threshold below which the API requests confirmation, default `0.55`
- `LOCAL_MODEL_MINIMUM_MACRO_F1`: minimum held-out macro-F1 required for artifact promotion, default `0.55`
- `LOCAL_MODEL_MINIMUM_PER_CLASS_F1`: minimum held-out F1 for every direct class, default `0.50`
- `LOCAL_MODEL_MAXIMUM_ECE`: maximum expected calibration error for promotion, default `0.30`
- `LOCAL_MODEL_MAXIMUM_NLL`: maximum negative log-likelihood for promotion, default `1.20`
- `LOCAL_MODEL_MAXIMUM_BRIER`: maximum multiclass Brier score for promotion, default `0.50`
- `LOCAL_MODEL_ALLOWED_REGRESSION`: tolerated macro-F1 regression versus the centroid baseline or incumbent, default `0.02`
- `TESSERACT_LANGUAGES`: OCR language pack list for Tesseract fallback, default `eng+pol`
- `CORS_ALLOW_ORIGINS`: comma-separated frontend origins allowed to call the AI API, defaults to local `localhost` and `127.0.0.1` dev hosts
- `APP_ENV`: set to `production` in production; this makes both Bearer tokens and an explicit browser origin allowlist mandatory
- `EISENHOWER_API_TOKEN`: user token shared with the Node API for ordinary task and AI operations
- `EISENHOWER_ADMIN_TOKEN`: separate 32+ character operator token for private training-data writes (including feedback), retraining and AI provider management; it must differ from the user token and must not be entered into product clients

Web and mobile ask only for the product access code and keep it in memory. They never request or retain the operator token. Do not put either credential in `VITE_*`, `EXPO_PUBLIC_*`, runtime-config.js, URLs, localStorage, or AsyncStorage. Because neither API authenticates with ambient cookies, classic credentialed CSRF is not applicable to the current authentication contract; unsafe browser requests are additionally rejected when their `Origin` is outside `CORS_ALLOW_ORIGINS`. Both APIs disable credentialed CORS, and the production web adapter explicitly uses Fetch `credentials: 'omit'` for every task and AI request while retaining the bearer header.

---

### Mobile

- `EXPO_PUBLIC_APP_ORIGIN_URL`: optional shared HTTPS origin for Expo, used to derive `/api` and `/ai`
- `EXPO_PUBLIC_API_URL`: Node API URL used for mobile task CRUD sync; if set, it must not be empty
- `EXPO_PUBLIC_AI_API_URL`: AI backend URL used by the Expo application; if set, it must not be empty

For GitHub Actions Android builds, `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_AI_API_URL` repository variables are required and must be public HTTP(S) URLs. The current production values are `https://tymon169-8081.mikrus.cloud/api` and `https://tymon169-8081.mikrus.cloud/ai`. `EXPO_PUBLIC_APP_ORIGIN_URL` remains optional and can be set to `https://tymon169-8081.mikrus.cloud`.

The required CI job produces an installability candidate from Expo's generated Android project. It is intentionally named `android-ci-candidate` because Expo signs that build with its generated debug keystore; it is not a production release artifact. After green CI on an exact `master` SHA, the `Release` workflow builds a separate production APK and fails closed unless all of the following are configured:

- secrets: `ANDROID_RELEASE_KEYSTORE_BASE64`, `ANDROID_RELEASE_STORE_PASSWORD`, `ANDROID_RELEASE_KEY_ALIAS`, `ANDROID_RELEASE_KEY_PASSWORD`;
- repository variable: `ANDROID_RELEASE_CERT_SHA256`, containing the pinned SHA-256 digest of the public signing certificate.

The production workflow never writes signing passwords into Gradle files. It verifies APK Signature Scheme v2, rejects `CN=Android Debug`, compares the signer certificate with the pinned digest, records the immutable commit SHA, and publishes the APK with checksum metadata. Keep the keystore and its recovery copy outside the repository.

## Local Development

Root commands:

- `make setup`
- `make test`
- `make test-bdd`
- `make build`
- `make verify`
- `make dev-web`
- `make dev-api`
- `make dev-ai`
- `make dev-mobile`

Before starting the root Docker Compose stack, copy `.env.example` to `.env` and replace every placeholder with a unique local credential.

`make verify` first prepares missing or stale worktree dependencies, then mirrors the local release-quality sweep used most often in CI: backend-node build + coverage + executable Cucumber/Gherkin BDD, web build + coverage + integration, backend-ai pytest, and mobile coverage. Preparation is bound to each Node lockfile and the recursively referenced backend-AI development requirements, so an unchanged worktree reuses its installed environments. Use `make setup` when an explicit force refresh is required. The current BDD slice documents the task lifecycle (including edit and stale-revision protection), tenant isolation, bearer/browser-origin protection, and request validation under `backend-node/features/`; it is intentionally narrower than repository-wide BDD.

The standard backend AI development environment installs `requirements-dev.txt`, which includes core runtime and test/audit tools but excludes research frameworks. Install `requirements-experimental.txt` separately only to run the opt-in LangChain/MinIO experiments.

The canonical application graph is `compose.yaml` for both development and production. Set
`APP_ENV` and `AUTH_MODE` explicitly; production accepts only OIDC. The default graph exposes
one host port from `gateway`; MongoDB, Qdrant, Node, FastAPI, n8n, Prometheus,
Grafana and OAuth2 Proxy have no host ports.

```bash
docker compose --env-file .env config
docker compose --env-file .env up -d --wait
```

n8n, Prometheus and Grafana are mandatory in that graph. Their consoles are
available only through the gateway after Keycloak grants the dedicated
`eisenhower-admin` realm role:

- `/admin/n8n/`
- `/admin/prometheus/`
- `/admin/grafana/`

The OAuth2 Proxy callback is `/oauth2/callback`. The only unauthenticated n8n
exception is `POST /eisenhower/google-calendar/webhook`; it does not expose the
editor or arbitrary n8n webhook paths. Assign `eisenhower-admin` only to named
operators and supply unique `ADMIN_OIDC_CLIENT_SECRET` and
`ADMIN_OIDC_COOKIE_SECRET` values outside version control. The admin session is
refreshed every minute and expires after 15 minutes; the gateway forwards refreshed
cookies so role revocation is re-evaluated within that bounded session window.

AMD and NVIDIA are standalone provider projects, not overlays of the application topology:

```bash
docker compose --env-file .env -f deploy/inference/compose.amd.yaml --profile inference-amd up -d
docker compose --env-file .env -f deploy/inference/compose.nvidia.yaml --profile inference-nvidia up -d
```

The application-side inference contract is exactly `INFERENCE_BASE_URL`,
`INFERENCE_API_KEY`, and `INFERENCE_ALLOWED_HOSTS`. Model and hardware settings belong only
to the provider project. Starting containers is not corpus, model-quality, deployment, or
production-acceptance evidence.

Per-service fallback:

1. `backend-node`: `cd backend-node && npm ci && npm run dev`
2. `backend-ai`: `cd backend-ai && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest pytest-cov httpx && .venv/bin/python -m uvicorn main:app --reload`
3. `web`: `cd web && npm ci && npm run dev`
4. `mobile`: `cd mobile/eisenhower-matrix && npm ci && npm run start`

The AI service is fully local. It uses a frozen multilingual MiniLM encoder plus a small PyTorch MLP head for quadrant classification, stores trained artifacts under `MODEL_CACHE_DIR`, and uses Tesseract for OCR. There is no OpenAI or native C++ classifier path in the default stack. The default MiniLM encoder is preloaded into the Docker image cache outside `/app`, so the compose bind mount does not hide it at runtime. Provider and training maintenance is private operator functionality and is not exposed in web or mobile product interfaces.

The classifier has one direct four-class contract: `0 Do Now`, `1 Delegate`, `2 Schedule`, `3 Delete`. It is not decomposed into two independently trained axes. Its versioned PL/EN evaluation set is separate from training data and from any RAG golden set. Retraining calibrates the MLP, compares it with a cosine-centroid embedding baseline and the incumbent artifact, and only promotes a candidate that passes macro/per-class and calibration gates. The API always returns one of the four quadrants; low calibrated confidence is exposed additively through `requires_confirmation` and `confidence_status`.

Run the reproducible local benchmark (semantic-grouped stratified five-fold validation, five training seeds, a disjoint calibration slice, and the standalone PL/EN evaluation) with:

```bash
cd backend-ai
PYTHONPATH=. python scripts/benchmark_classifier.py --output /tmp/eisenhower-classifier-benchmark.json
```

This report is local classifier evidence only. The bundled 32-example synthetic set is a development smoke set, not canonical production evidence. It does not exercise RAG and does not prove that any artifact is deployed in production.

Production promotion is fail-closed. `compose.yaml` requires an externally supplied, read-only evaluation file (`AI_EVALUATION_FILE`) and its approved SHA-256 (`LOCAL_MODEL_APPROVED_EVALUATION_SHA256`). A production evaluation must be frozen, independent from training, dual-annotated by two humans, have both raw agreement and Cohen's kappa of at least `0.80`, contain at least 240 examples, and contain at least 30 examples for every language/class slice. The default MiniLM encoder is pinned to the immutable Hugging Face revision `e8f8c211226b894fcb81acc59f3b34ba3efd5f42`, and saved MLP artifacts from another encoder revision are rejected. Training-management endpoints are disabled in that production compose profile; approved retraining is an explicit offline operation. The liveness and readiness endpoints are `/health/live` and `/health/ready`.

The human packet is under `backend-ai/evaluation/production-v1/`. Give each annotator only `pool.jsonl`, one separate blank response file, and `annotation-guide.md`; keep `internal-strata.jsonl`, model output, and the other annotator's file hidden until both blind files are complete and hashed. After human adjudication, `scripts/finalize_annotations.py` produces a still-unapproved candidate and `scripts/freeze_evaluation.py` requires a named human approval before it emits the canonical dataset and SHA-256 manifest. Neither script can turn blank annotations into production evidence.

The Expo mobile client now keeps a local task cache in AsyncStorage, refreshes and mutates tasks through `backend-node` when available, and sends picked images to `backend-ai` OCR via `expo-image-picker`.

## Frontend E2E

- Install browsers once: `cd web && npm run test:e2e:install`
- Run the smoke suite: `cd web && npm run test:e2e`
- Run the live AI smoke manually with `PLAYWRIGHT_API_TOKEN` and `PLAYWRIGHT_ADMIN_TOKEN`: `cd web && npm run test:e2e:ai-smoke`

The Playwright suite starts an isolated Vite frontend plus a real Node API backed by an ephemeral `mongodb-memory-server` instance, so it does not depend on a manually running MongoDB container.

The manual AI smoke does the opposite: it does not start any local test servers and instead expects the live frontend and AI runtime to already be available, by default on `http://127.0.0.1:5173` and `http://127.0.0.1:8000`.

### Production AI scope

The canonical runtime keeps MongoDB and Qdrant private and routes AI only through the gateway.
Classifier, retrieval and generated-response capabilities retain independent fail-closed gates.
Provider readiness, image rendering, or a green release does not prove real traffic, human quality
or public production acceptance.

---

## Frontend Integration

- Install dependencies in both packages: `cd backend-node && npm ci` and `cd web && npm ci`
- Run the suite: `cd web && npm run test:integration`

The integration suite renders the React app in JSDOM, but talks to a real Express API backed by `mongodb-memory-server`, so CRUD is exercised without mocking `./services/api` or `fetch`.

## Deployment and release

`ci.yml` proves the source SHA. `release.yml` preserves the existing exact-green-master-SHA
preflight, then builds and scans every complete first-party image before the aggregate
`publish-release` job can publish anything. The final artifact binds the source SHA to registry
RepoDigests and SHA-256 checksums of every Trivy report and CycloneDX SBOM.

`deploy.yml` is deliberately separate and generic. It downloads that immutable manifest and calls
`deploy/generic/deploy.sh`, which forces `APP_ENV=production` and `AUTH_MODE=oidc`, renders the
single Compose graph, pulls only manifest-bound digests, verifies OCI revision labels, and preserves
a rollback manifest. The historical AWS force-redeploy and Mikrus-specific workflow were removed:
neither proved that the requested release digest was running.

Backup and confirmation-gated restore live in `deploy/generic/`. MongoDB is canonical; Qdrant is
rebuildable and follows its separately verified snapshot/reindex procedure. A green workflow,
published manifest, or successful local render remains distinct from an authorized deploy, public
runtime checks and human acceptance.

### Task HTTP concurrency and pagination

Task responses expose a numeric `revision` and an `ETag` containing that revision. Updated clients
can send the received ETag in `If-Match` on `PUT /tasks/:id` or `DELETE /tasks/:id`; a stale revision
returns `412` with `code=task_revision_conflict` and does not mutate the task. For compatibility,
legacy requests without `If-Match` remain accepted while clients migrate to conditional writes.

`GET /tasks` still returns the historical JSON array. Optional `limit` (1-200) and opaque `cursor`
query parameters add cursor pagination without changing that body shape. When another page exists,
the response exposes `X-Next-Cursor` and an RFC 8288-style `Link` header. In OIDC mode list, update
and delete operations always scope records by both `tenantId` and `ownerId`; production rejects a
host-selected static authentication mode.

`POST /tasks` accepts a scoped `Idempotency-Key`. An exact replay returns the original task, while
reusing the key with another payload returns `409`. Deleting an idempotently created task retains
only a redacted operation tombstone: later exact replays return
`410 code=idempotency_result_deleted` and cannot recreate the deleted task or recover its private
title or description.

For HTTPS deployments behind a public host, prefer `VITE_API_URL=/api` and `VITE_AI_API_URL=/ai`, and set `CORS_ALLOW_ORIGINS` to the public frontend origin.
Reference files:

- `compose.yaml` for the canonical application topology
- `.env.example` for host-neutral configuration names without operational secrets
- `deploy/generic/` for manifest-bound deploy, backup, restore and rollback
- [`docs/RELEASE_BASE_IMAGES.md`](docs/RELEASE_BASE_IMAGES.md) for digest policy, current exceptions and the controlled update procedure

## Quality Gates

Target required checks for both `dev` and `master`:

- `branch-policy`
- `resolve-run-mode`
- `security-lint`
- `test-backend-node`
- `test-api-client`
- `test-mcp-adapter`
- `test-n8n-workflows`
- `test-frontend`
- `test-frontend-integration`
- `test-frontend-e2e`
- `test-backend-ai`
- `test-mobile`
- `test-mobile-native-android`

The workflow implements these stable checks with explicit successful not-applicable paths driven by the versioned, merge-base-aware `ci-impact-plan/v1`. Risky, unknown, release and scheduled inputs fail closed to full CI. GitHub branch rules are external state and must be verified after the changes are published. See [`docs/PRODUCTION_ACCEPTANCE.md`](docs/PRODUCTION_ACCEPTANCE.md) for the exact separation between local, CI, and public-runtime evidence.

Workflows use read-only tokens by default, grant write scopes only to the governed master-to-dev synchronizer, pin external Actions and CI service images immutably, and bound every job with a timeout. Release secrets stay behind an exact-green-master preflight. Repository-wide default token permissions are external GitHub state and must be independently verified as read-only with workflow PR approvals disabled.

The impact graph, fail-closed rules and measured baseline/savings boundary are documented in [`docs/CI_IMPACT_PLAN.md`](docs/CI_IMPACT_PLAN.md).

Coverage thresholds remain service-specific. The web and backend services enforce `100%`, while the Expo mobile client currently enforces `95%` statements/functions/lines and `90%` branches.
The `test-mobile-native-android` job uploads a downloadable CI candidate APK from each successful run. The same `ci.yml` workflow can also be started manually with `workflow_dispatch`, so you can trigger a candidate build from the GitHub Actions UI for a branch without merging it first. Only the production-signed artifact emitted by the post-`master` `Release` workflow is eligible for physical release acceptance.

---

## Maintenance profile

The canonical graph always starts n8n, Prometheus and Grafana. The only profile is
`maintenance`, which exposes no host port and is used by backup/restore helpers.
AMD/NVIDIA inference runs as a separate provider project and never changes the application graph.
