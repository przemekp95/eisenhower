PYTHON ?= python3
NPM ?= npm
BACKEND_AI_VENV ?= backend-ai/.venv
BACKEND_AI_PYTHON ?= $(BACKEND_AI_VENV)/bin/python
BACKEND_AI_PIP ?= $(BACKEND_AI_VENV)/bin/pip

.PHONY: setup test build verify dev-web dev-api dev-ai dev-mobile

setup:
	cd backend-node && $(NPM) ci
	cd web && $(NPM) ci
	cd mobile/eisenhower-matrix && $(NPM) ci
	test -x $(BACKEND_AI_PYTHON) || $(PYTHON) -m venv $(BACKEND_AI_VENV)
	$(BACKEND_AI_PIP) install -r backend-ai/requirements.txt pytest pytest-cov httpx

test:
	cd backend-node && $(NPM) test
	cd web && $(NPM) test
	$(BACKEND_AI_PYTHON) -m pytest backend-ai
	cd mobile/eisenhower-matrix && $(NPM) test

build:
	cd backend-node && $(NPM) run build
	cd web && $(NPM) run build

verify:
	cd backend-node && $(NPM) run build && $(NPM) run test:coverage
	cd web && $(NPM) run build && $(NPM) run test:coverage && $(NPM) run test:integration
	$(BACKEND_AI_PYTHON) -m pytest backend-ai
	cd mobile/eisenhower-matrix && $(NPM) run test:coverage

dev-web:
	cd web && $(NPM) run dev

dev-api:
	cd backend-node && $(NPM) run dev

dev-ai:
	cd backend-ai && .venv/bin/python -m uvicorn main:app --reload

dev-mobile:
	cd mobile/eisenhower-matrix && $(NPM) run start
