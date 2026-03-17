# AGENTS.md

Internal notes for coding agents working in this repository.

## Cold Start Bootstrap

Use this plan after a fresh clone when the goal is to get the project running quickly without relying on untracked local files.

### Preferred path: Docker Compose

This is the fastest reliable path for `web` + `backend-node` + `backend-ai`, because it also brings up MongoDB.

1. Run `docker compose up --build`
2. Wait for services to become healthy
3. Open:
   - web: `http://localhost:3000`
   - backend health: `http://localhost:3001/health/ready`
   - AI health: `http://localhost:8000/`

Notes:

- A tracked `.env` file is not required for the default local stack.
- The first `backend-ai` build/start can be noticeably slower because it installs PyTorch, Tesseract, and preloads the sentence-transformer model.
- Prefer this path whenever the backend must work immediately after clone.

### Manual local dev path

Use this only when Docker is unavailable or when individual services need to run outside containers.

1. Run `make setup`
2. Start MongoDB separately with `docker compose up mongodb`
3. In separate terminals, start:
   - `make dev-ai`
   - `make dev-api`
   - `make dev-web`
4. Optional: start mobile with `make dev-mobile`

Default local URLs:

- web: `http://127.0.0.1:5173`
- backend-node: `http://127.0.0.1:3001`
- backend-ai: `http://127.0.0.1:8000`

Important:

- `make dev-api` depends on MongoDB being available.
- Expo mobile dev falls back to `127.0.0.1:3001` and `127.0.0.1:8000` in development.

### Quick smoke checks

Run these after startup:

- `curl http://127.0.0.1:3001/health/ready`
- `curl http://127.0.0.1:8000/`
- open the web UI and confirm task CRUD loads

### If startup fails

Check these first:

- Docker daemon not running
- port conflicts on `3000`, `3001`, `5173`, `8000`, or `27017`
- slow or failed AI dependency/model install on first build
- backend-node failing because MongoDB was not started in manual mode
