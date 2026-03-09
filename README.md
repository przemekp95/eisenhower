# Eisenhower Matrix

Monorepo for the Eisenhower Matrix application with a React web client, a Node/Express API, a FastAPI AI service, and an Expo mobile client.

## Branch Flow

- `feature/* -> dev`
- `dev -> master`
- `master` remains the default branch
- `dev` and `master` are protected with GitHub rulesets

Pull requests into `master` are allowed only from `dev`. While the repository has a single maintainer, the required approval count remains `0`, but pull requests and passing checks are mandatory.

## Services

- `web`: React + Vite frontend for task CRUD and AI tools
- `backend-node`: REST API for tasks and health checks
- `backend-ai`: FastAPI service for classification, OCR, and batch analysis
- `mobile/eisenhower-matrix`: Expo / React Native client

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
- `JWT_SECRET`: required outside test environments

### Backend AI

- `TRAINING_DATA_PATH`: path to the training examples file
- `MODEL_CACHE_DIR`: directory used for model and cache artifacts
- `LOCAL_MODEL_NAME`: sentence-transformer used as the frozen encoder, default `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`
- `LOCAL_MODEL_EPOCHS`: max epochs for explicit retraining, default `60`
- `LOCAL_MODEL_PATIENCE`: early-stopping patience for explicit retraining, default `8`
- `LOCAL_MODEL_HIDDEN_DIM`: hidden layer width for the classification head, default `128`
- `LOCAL_MODEL_DROPOUT`: dropout for the classification head, default `0.1`
- `LOCAL_MODEL_LEARNING_RATE`: optimizer learning rate for the classification head, default `0.01`
- `TESSERACT_LANGUAGES`: OCR language pack list for Tesseract fallback, default `eng+pol`
- `CORS_ALLOW_ORIGINS`: comma-separated frontend origins allowed to call the AI API, defaults to local `localhost` and `127.0.0.1` dev hosts

### Mobile

- `EXPO_PUBLIC_API_URL`: Node API URL used for mobile task CRUD sync
- `EXPO_PUBLIC_AI_API_URL`: AI backend URL used by the Expo application

## Local Development

1. `backend-node`: `cd backend-node && npm ci && npm run dev`
2. `backend-ai`: `cd backend-ai && python3 -m pip install -r requirements.txt && python3 -m uvicorn main:app --reload`
3. `web`: `cd web && npm ci && npm run dev`
4. `mobile`: `cd mobile/eisenhower-matrix && npm ci && npm run start`

The AI service is fully local. It uses a frozen multilingual MiniLM encoder plus a small PyTorch MLP head for quadrant classification, stores trained artifacts under `MODEL_CACHE_DIR`, and uses Tesseract for OCR. There is no OpenAI or native C++ classifier path in the default stack. The default MiniLM encoder is preloaded into the Docker image cache outside `/app`, so the compose bind mount does not hide it at runtime. The AI management panel can also enable or disable the deployed `local_model` and `tesseract` providers, and those switches persist under the runtime cache.

The Expo mobile client now keeps a local task cache in AsyncStorage, refreshes and mutates tasks through `backend-node` when available, and sends picked images to `backend-ai` OCR via `expo-image-picker`.

## Frontend E2E

- Install browsers once: `cd web && npm run test:e2e:install`
- Run the smoke suite: `cd web && npm run test:e2e`
- Run the live AI smoke manually: `cd web && npm run test:e2e:ai-smoke`

The Playwright suite starts an isolated Vite frontend plus a real Node API backed by an ephemeral `mongodb-memory-server` instance, so it does not depend on a manually running MongoDB container.

The manual AI smoke does the opposite: it does not start any local test servers and instead expects the live frontend and AI runtime to already be available, by default on `http://127.0.0.1:5173` and `http://127.0.0.1:8000`.

## Frontend Integration

- Install dependencies in both packages: `cd backend-node && npm ci` and `cd web && npm ci`
- Run the suite: `cd web && npm run test:integration`

The integration suite renders the React app in JSDOM, but talks to a real Express API backed by `mongodb-memory-server`, so CRUD is exercised without mocking `./services/api` or `fetch`.

## Mikrus Deployment

Pushes to `master` run `release.yml`, which can deploy to Mikrus over SSH when secrets are configured.

- `DOCKER_HUB_USERNAME`: Docker Hub namespace used for images
- `DOCKER_HUB_TOKEN`: Docker Hub token (optional for pull, required for image push in workflow)
- `MIKRUS_HOST`: server host (IPv6 is supported)
- `MIKRUS_USER`: SSH user (`root` supported)
- `MIKRUS_SSH_KEY`: private key content used by GitHub Actions
- `MIKRUS_ENV_FILE`: full `.env` content written on the server
- `MIKRUS_APP_DIR`: optional deploy directory override

Default deploy directory is `/home/<MIKRUS_USER>/apps/demo-fortis`, except `root` which defaults to `/root/apps/demo-fortis`.
The example Mikrus env uses `WEB_PORT=8080` to avoid common `3000` collisions on shared hosts. If your target already listens on any configured host port, update `WEB_PORT`, `API_PORT`, `AI_PORT`, and matching URLs in `MIKRUS_ENV_FILE` before redeploying.
For HTTPS deployments behind a public host, prefer `VITE_API_URL=/api` and `VITE_AI_API_URL=/ai`, and set `CORS_ALLOW_ORIGINS` to the public frontend origin.
Reference files:

- `deploy/mikrus/docker-compose.yml`
- `deploy/mikrus/.env.example`

## Quality Gates

Required checks for both `dev` and `master`:

- `branch-policy`
- `security-lint`
- `test-backend-node`
- `test-frontend`
- `test-frontend-integration`
- `test-frontend-e2e`
- `test-backend-ai`
- `test-mobile`
- `test-mobile-native-android`

Coverage thresholds remain service-specific. The web and backend services enforce `100%`, while the Expo mobile client currently enforces `95%` statements/functions/lines and `90%` branches.
