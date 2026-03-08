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

### Mobile

- `EXPO_PUBLIC_AI_API_URL`: AI backend URL used by the Expo application

## Local Development

1. `backend-node`: `cd backend-node && npm ci && npm run dev`
2. `backend-ai`: `cd backend-ai && python3 -m pip install -r requirements.txt && python3 -m uvicorn main:app --reload`
3. `web`: `cd web && npm ci && npm run dev`
4. `mobile`: `cd mobile/eisenhower-matrix && npm ci && npm run start`

## Frontend E2E

- Install browsers once: `cd web && npm run test:e2e:install`
- Run the smoke suite: `cd web && npm run test:e2e`

The Playwright suite starts an isolated Vite frontend plus a real Node API backed by an ephemeral `mongodb-memory-server` instance, so it does not depend on a manually running MongoDB container.

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

Each active service enforces its own coverage threshold of `>= 80%`.
