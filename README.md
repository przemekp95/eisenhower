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
- `qdrant`: opt-in vector store for the canonical local RAG profile; not enabled in the current Mikrus runtime
- `minio`: experimental local-profile service, not a dependency of the supported runtime

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

`make verify` mirrors the local release-quality sweep used most often in CI: backend-node build + coverage + executable Cucumber/Gherkin BDD, web build + coverage + integration, backend-ai pytest, and mobile coverage. The current BDD slice documents the task lifecycle (including edit and stale-revision protection), tenant isolation, bearer/browser-origin protection, and request validation under `backend-node/features/`; it is intentionally narrower than repository-wide BDD.

The standard backend AI development environment installs `requirements-dev.txt`, which includes core runtime and test/audit tools but excludes research frameworks. Install `requirements-experimental.txt` separately only to run the opt-in LangChain/MinIO experiments.

The retrieval topology is opt-in and remains independent from the inference host:

```bash
docker compose --profile rag up qdrant rag-worker ai-service
```

For a local NVIDIA/CUDA or AMD/ROCm inference candidate, add exactly one disabled profile file:

```bash
docker compose -f docker-compose.yml -f deploy/inference/compose.nvidia.yaml \
  --profile rag --profile inference-nvidia up qdrant rag-worker inference ai-service
docker compose -f docker-compose.yml -f deploy/inference/compose.amd.yaml \
  --profile rag --profile inference-amd up qdrant rag-worker inference ai-service
```

For a dedicated or user-computer GPU host, run only the private inference service there and set
`INFERENCE_BASE_URL`, `INFERENCE_ALLOWED_HOSTS`, `INFERENCE_API_KEY` and `INFERENCE_MODEL` on
FastAPI. Neither profile publishes port 8000 on the host. These definitions are contract-only
candidates, not proof of image compatibility, model loading, GPU capacity, performance or production readiness.

RAG rollout uses independent server-side flags. Start with
`RAG_RETRIEVAL_ENABLED=true`, `RAG_GENERATION_ENABLED=false`, and
`RAG_RESPONSE_ENABLED=false` to exercise Qdrant retrieval and aggregate shadow metrics without
calling inference or exposing retrieved content in analysis responses. Enable generation only after the
retrieval gates pass, and enable responses only for an approved tenant cohort. `RAG_ENABLED` is a
legacy compatibility switch that enables both retrieval and generation when the explicit flags are
absent; new environments should use the phase-specific flags.

The retrieval-only local topology does not require the GPU profile:

```bash
docker compose --profile rag up qdrant rag-worker ai-service
```

This still requires an approved synthetic or real corpus command path before a search can return
useful hits; starting empty services is not a corpus, quality, privacy, or production gate.

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

Production promotion is fail-closed. `deploy/mikrus/docker-compose.yml` requires an externally supplied, read-only evaluation file (`AI_EVALUATION_FILE`) and its approved SHA-256 (`LOCAL_MODEL_APPROVED_EVALUATION_SHA256`). A production evaluation must be frozen, independent from training, dual-annotated by two humans, have both raw agreement and Cohen's kappa of at least `0.80`, contain at least 240 examples, and contain at least 30 examples for every language/class slice. The default MiniLM encoder is pinned to the immutable Hugging Face revision `e8f8c211226b894fcb81acc59f3b34ba3efd5f42`, and saved MLP artifacts from another encoder revision are rejected. Training-management endpoints are disabled in that production compose profile; approved retraining is an explicit offline operation. The liveness and readiness endpoints are `/health/live` and `/health/ready`.

The human packet is under `backend-ai/evaluation/production-v1/`. Give each annotator only `pool.jsonl`, one separate blank response file, and `annotation-guide.md`; keep `internal-strata.jsonl`, model output, and the other annotator's file hidden until both blind files are complete and hashed. After human adjudication, `scripts/finalize_annotations.py` produces a still-unapproved candidate and `scripts/freeze_evaluation.py` requires a named human approval before it emits the canonical dataset and SHA-256 manifest. Neither script can turn blank annotations into production evidence.

The Expo mobile client now keeps a local task cache in AsyncStorage, refreshes and mutates tasks through `backend-node` when available, and sends picked images to `backend-ai` OCR via `expo-image-picker`.

## Frontend E2E

- Install browsers once: `cd web && npm run test:e2e:install`
- Run the smoke suite: `cd web && npm run test:e2e`
- Run the live AI smoke manually with `PLAYWRIGHT_API_TOKEN` and `PLAYWRIGHT_ADMIN_TOKEN`: `cd web && npm run test:e2e:ai-smoke`

The Playwright suite starts an isolated Vite frontend plus a real Node API backed by an ephemeral `mongodb-memory-server` instance, so it does not depend on a manually running MongoDB container.

The manual AI smoke does the opposite: it does not start any local test servers and instead expects the live frontend and AI runtime to already be available, by default on `http://127.0.0.1:5173` and `http://127.0.0.1:8000`.

### Production AI scope

The current Mikrus production runtime is intentionally limited to the local multilingual MiniLM classifier, its local similarity index, deterministic explanations, and Tesseract OCR. Legacy endpoint and payload names containing `langchain` or `rag` are retained for client compatibility, but they do not claim an active LLM, LangChain retrieval chain, Qdrant dependency, or generative reasoning.

Qdrant is the selected vector store behind the opt-in canonical RAG ports and its client is a core dependency, but Qdrant/vLLM/RAG are not enabled by the current Mikrus Compose file. LangChain and MinIO remain research-only integrations whose dependencies live in `requirements-experimental.txt`; they are not installed by the production image or standard dev setup and are never eagerly imported by the core vector package. None of these opt-in paths is production acceptance evidence without the separate runtime gates.

---

## Frontend Integration

- Install dependencies in both packages: `cd backend-node && npm ci` and `cd web && npm ci`
- Run the suite: `cd web && npm run test:integration`

The integration suite renders the React app in JSDOM, but talks to a real Express API backed by `mongodb-memory-server`, so CRUD is exercised without mocking `./services/api` or `fetch`.

## Mikrus Deployment

A successful `CI` push run on `master` triggers `release.yml`, which builds images tagged with the full commit SHA and can deploy them to Mikrus over SSH when secrets are configured. A full-SHA tag identifies the intended source revision but remains a mutable registry tag; the current deployment does not yet bind the three first-party images by registry digest.

The existing `deploy/mikrus/docker-compose.yml` topology deliberately runs `backend-node` with
`AUTH_MODE=static` and the shared `EISENHOWER_API_TOKEN`. It is a static, single-tenant deployment:
the authenticated principal is always `tenantId=local`, `ownerId=local-user`. This profile is not
OIDC, does not establish per-person accounts, and must not be described as multi-user production.
An OIDC deployment must instead supply the issuer, audience and same-origin HTTPS JWKS settings and
isolate every task by both the authenticated tenant and subject.

Node readiness calls the AI service's `/health/ready` endpoint with a bounded timeout. MongoDB remains a
required readiness dependency; unavailable AI is reported as degraded but does not block web/task CRUD.
The Mikrus rollout applies the same boundary: core web/API readiness and smoke checks can succeed without
private knowledge or GPU, while AI readiness remains separately observable and AI requests still fail
closed when their grounded upstream is unavailable.

### Task HTTP concurrency and pagination

Task responses expose a numeric `revision` and an `ETag` containing that revision. Updated clients
can send the received ETag in `If-Match` on `PUT /tasks/:id` or `DELETE /tasks/:id`; a stale revision
returns `412` with `code=task_revision_conflict` and does not mutate the task. For compatibility,
legacy requests without `If-Match` remain accepted while clients migrate to conditional writes.

`GET /tasks` still returns the historical JSON array. Optional `limit` (1-200) and opaque `cursor`
query parameters add cursor pagination without changing that body shape. When another page exists,
the response exposes `X-Next-Cursor` and an RFC 8288-style `Link` header. In OIDC mode list, update
and delete operations always scope records by both `tenantId` and `ownerId`; the static profile maps
to the fixed local principal described above.

`POST /tasks` accepts a scoped `Idempotency-Key`. An exact replay returns the original task, while
reusing the key with another payload returns `409`. Deleting an idempotently created task retains
only a redacted operation tombstone: later exact replays return
`410 code=idempotency_result_deleted` and cannot recreate the deleted task or recover its private
title or description.

- `DOCKER_HUB_USERNAME`: Docker Hub namespace used for images
- `DOCKER_HUB_TOKEN`: Docker Hub token required for a publishable release and Mikrus deployment
- `MIKRUS_HOST`: server host (IPv6 is supported)
- `MIKRUS_USER`: SSH user (`root` supported)
- `MIKRUS_SSH_KEY`: private key content used by GitHub Actions
- `MIKRUS_ENV_FILE`: full `.env` content written on the server
- `MIKRUS_APP_DIR`: required absolute deploy directory
- `MIKRUS_PUBLIC_URL`: public HTTPS origin used by post-deploy smoke checks

The deploy script creates and verifies `.eisenhower-deployment`; it refuses a non-empty target without that ownership marker. Existing deployments must add a marker containing exactly `eisenhower` before the first hardened deployment.
The example Mikrus env uses `WEB_PORT=8080` to avoid common `3000` collisions on shared hosts. Only the frontend publishes a host port; API and AI stay on the Compose network. If the frontend port is occupied, update `WEB_PORT` in `MIKRUS_ENV_FILE` before redeploying.
For HTTPS deployments behind a public host, prefer `VITE_API_URL=/api` and `VITE_AI_API_URL=/ai`, and set `CORS_ALLOW_ORIGINS` to the public frontend origin.
Reference files:

- `deploy/mikrus/docker-compose.yml`
- `deploy/mikrus/.env.example`
- `deploy/mikrus/backup.sh` and `restore.sh` for checksum-verified data recovery; restore additionally requires `RESTORE_CONFIRM=restore-eisenhower-data`
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

## Experimental local profiles

The root Compose file exposes Qdrant under the `rag` profile for the canonical local RAG topology and under `experimental` for isolated vector research. MinIO remains experimental. None of these services is consumed by the default classifier runtime or enabled by the current Mikrus deployment.
