PYTHON ?= python3
NPM ?= npm
UV ?= uv
BACKEND_AI_VENV ?= backend-ai/venv
BACKEND_AI_PYTHON ?= $(BACKEND_AI_VENV)/bin/python
BACKEND_AI_PIP ?= $(BACKEND_AI_VENV)/bin/pip

.PHONY: setup test test-bdd test-ai test-api-client test-mcp typecheck-node lint lint-ai format format-web format-check format-check-web build audit-production verify dev-web dev-api dev-ai dev-mobile

setup:
	cd backend-node && $(NPM) ci
	$(NPM) --prefix packages/api-client ci
	cd web && $(NPM) ci
	cd mobile/eisenhower-matrix && $(NPM) ci
	test -x $(BACKEND_AI_PYTHON) || $(PYTHON) -m venv $(BACKEND_AI_VENV)
	$(BACKEND_AI_PIP) install -r backend-ai/requirements-dev.txt

test:
	cd backend-node && $(NPM) test
	$(MAKE) test-bdd
	cd web && $(NPM) test
	COVERAGE_RCFILE=backend-ai/.coveragerc $(BACKEND_AI_PYTHON) -m pytest backend-ai/tests
	cd mobile/eisenhower-matrix && $(NPM) test

test-bdd:
	cd backend-node && $(NPM) run test:bdd

test-ai:
	COVERAGE_RCFILE=backend-ai/.coveragerc $(BACKEND_AI_PYTHON) -m pytest backend-ai/tests

test-api-client:
	$(NPM) --prefix packages/api-client run check

test-mcp:
	UV_LINK_MODE=copy $(UV) run --project mcp/eisenhower_adapter --locked python -W error -m unittest discover -s mcp/eisenhower_adapter/tests -v

typecheck-node:
	cd backend-node && $(NPM) exec -- tsc --noEmit -p tsconfig.json

lint:
	$(MAKE) lint-ai
	$(MAKE) format-check-web

lint-ai:
	$(BACKEND_AI_PYTHON) -m pylint --rcfile=backend-ai/.pylintrc --fail-under=10.0 backend-ai/app

format:
	$(MAKE) format-web

format-web:
	cd web && npx prettier --write "src/**/*.{ts,tsx,js,jsx,css}" "*.{js,ts,json}"

format-check:
	$(MAKE) format-check-web

format-check-web:
	cd web && npx prettier --check "src/**/*.{ts,tsx,js,jsx,css}" "*.{js,ts,json}"

build:
	cd backend-node && $(NPM) run build
	cd web && $(NPM) run build

audit-production:
	cd backend-node && $(NPM) audit --omit=dev --audit-level=high
	cd web && $(NPM) audit --omit=dev --audit-level=high
	cd mobile/eisenhower-matrix && $(NPM) run audit:production
	$(BACKEND_AI_PYTHON) -m pip_audit -r backend-ai/requirements.txt

verify:
	$(MAKE) audit-production
	$(MAKE) test-api-client
	$(MAKE) test-mcp
	cd backend-node && $(NPM) run build && $(NPM) run test:coverage
	$(MAKE) test-bdd
	cd web && $(NPM) run format:check && $(NPM) run build && $(NPM) run test:coverage && $(NPM) run test:integration
	COVERAGE_RCFILE=backend-ai/.coveragerc $(BACKEND_AI_PYTHON) -m pytest backend-ai/tests
	cd mobile/eisenhower-matrix && $(NPM) run test:coverage
	$(MAKE) typecheck-node
	$(MAKE) lint-ai

dev-web:
	cd web && $(NPM) run dev

dev-api:
	cd backend-node && $(NPM) run dev

dev-ai:
	cd backend-ai && .venv/bin/python -m uvicorn main:app --reload

dev-mobile:
	cd mobile/eisenhower-matrix && $(NPM) run start
