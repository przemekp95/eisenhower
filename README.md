# Eisenhower

Monorepo dla aplikacji Eisenhower Matrix z webowym klientem React, backendem Node/Express, serwisem AI opartym o FastAPI oraz mobilnym klientem Expo.

## Branch flow

- `feature/* -> dev`
- `dev -> master`
- `master` pozostaje branch domyślnym
- `dev` i `master` są chronione przez GitHub rulesets

PR do `master` jest dozwolony wyłącznie z `dev`. Dopóki repo ma jednego maintainera, approval count pozostaje `0`, ale PR i zielone checki są wymagane.

## Services

- `web`: React + Vite frontend dla CRUD zadań i narzędzi AI
- `backend-node`: REST API dla zadań i health checks
- `backend-ai`: FastAPI service do klasyfikacji, OCR i batch analysis
- `mobile/eisenhower-matrix`: klient Expo/React Native

## Runtime config

### Web

- `VITE_API_URL`: adres backendu Node, domyślnie `http://localhost:3001`
- `VITE_AI_API_URL`: adres backendu AI, domyślnie `http://localhost:8000`

### Backend Node

- `PORT`: port HTTP, domyślnie `3001`
- `MONGODB_URI`: Mongo connection string
- `AI_SERVICE_URL`: adres backendu AI
- `JWT_SECRET`: wymagany tylko poza testami

### Backend AI

- `TRAINING_DATA_PATH`: ścieżka do pliku z przykładami treningowymi
- `MODEL_CACHE_DIR`: katalog na cache/model artifacts

### Mobile

- `EXPO_PUBLIC_AI_API_URL`: adres backendu AI używany przez Expo app

## Local development

1. `backend-node`
   `cd backend-node && npm ci && npm run dev`
2. `backend-ai`
   `cd backend-ai && python -m pip install -r requirements.txt && uvicorn main:app --reload`
3. `web`
   `cd web && npm ci && npm run dev`
4. `mobile`
   `cd mobile/eisenhower-matrix && npm ci && npm run start`

## Quality gates

Wymagane checki dla `dev` i `master`:

- `branch-policy`
- `security-lint`
- `test-backend-node`
- `test-frontend`
- `test-backend-ai`
- `test-mobile`

Każdy aktywny serwis ma własny próg coverage `>= 80%`.
