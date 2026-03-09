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

### Backend Node

- `PORT`: HTTP port, default `3001`
- `MONGODB_URI`: MongoDB connection string
- `AI_SERVICE_URL`: AI backend base URL
- `JWT_SECRET`: required outside test environments

### Backend AI

- `TRAINING_DATA_PATH`: path to the training examples file
- `MODEL_CACHE_DIR`: directory used for model and cache artifacts
- `OPENAI_API_KEY`: enables OpenAI reasoning, vision OCR, and embedding-backed similarity review
- `OPENAI_BASE_URL`: optional OpenAI-compatible API base URL
- `OPENAI_CLASSIFICATION_MODEL`: structured-output model for optional model review, default `gpt-4o-mini`
- `OPENAI_REASONING_MODEL`: model for deeper task analysis, default `gpt-4o-mini`
- `OPENAI_VISION_MODEL`: model used for image task extraction, default `gpt-4o-mini`
- `OPENAI_EMBEDDING_MODEL`: model used for similarity lookup, default `text-embedding-3-small`
- `OPENAI_TIMEOUT_SECONDS`: request timeout for OpenAI calls, default `30`
- `TESSERACT_LANGUAGES`: OCR language pack list for Tesseract fallback, default `eng+pol`
- `CORS_ALLOW_ORIGINS`: comma-separated frontend origins allowed to call the AI API, defaults to local `localhost` and `127.0.0.1` dev hosts

### Mobile

- `EXPO_PUBLIC_AI_API_URL`: AI backend URL used by the Expo application

## Local Development

1. `backend-node`: `cd backend-node && npm ci && npm run dev`
2. `backend-ai`: `cd backend-ai && python3 -m pip install -r requirements.txt && python3 -m uvicorn main:app --reload`
3. `web`: `cd web && npm ci && npm run dev`
4. `mobile`: `cd mobile/eisenhower-matrix && npm ci && npm run start`

The AI service classifies tasks locally by default from the experience store and the rebuilt similarity index. When `OPENAI_API_KEY` is present, OpenAI augments that local path with reasoning, vision OCR, and embedding-backed similarity review. Without the key, the service still keeps the local classifier and uses Tesseract OCR where available.

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

Each active service enforces its own coverage threshold of `100%`.
