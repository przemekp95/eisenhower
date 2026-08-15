# Multi-stage build for the vendor-neutral FastAPI application boundary.

# Bazowy obraz wspólny dla wszystkich wersji
FROM python:3.11-slim AS base

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=on \
    PIP_DISABLE_PIP_VERSION_CHECK=on \
    PIP_DEFAULT_TIMEOUT=100 \
    HF_HOME=/home/app/.cache/huggingface

WORKDIR /app

# Create non-root user
RUN useradd --create-home --shell /bin/bash app \
    && chown -R app:app /app
USER app

# ------------------------------------------------------------------------------
# Target: lightweight transport boundary (no model, OCR, storage or RAG runtime)
# ------------------------------------------------------------------------------
FROM base AS dependencies-boundary
COPY --chown=app:app requirements-boundary.txt .
RUN pip install --user -r requirements-boundary.txt

FROM base AS api-boundary
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA \
      org.opencontainers.image.role=ai-boundary
COPY --from=dependencies-boundary --chown=app:app /home/app/.local /home/app/.local
ENV PATH=/home/app/.local/bin:$PATH
COPY --chown=app:app app/__init__.py app/api_boundary.py ./app/
USER root
RUN python -m pip uninstall -y setuptools wheel
USER app
HEALTHCHECK --interval=30s --timeout=5s --start-period=2s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=3)" || exit 1
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.api_boundary:from_environment", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

# ------------------------------------------------------------------------------
# Target: Dependencies (CPU - domyślna wersja)
# ------------------------------------------------------------------------------
FROM base AS dependencies-cpu
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        git \
        libffi-dev \
        libgomp1 \
        libmagic1 \
        poppler-utils \
        tesseract-ocr \
        tesseract-ocr-pol \
        libtesseract-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/cache/apt/archives/* \
    && rm -rf /tmp/*

USER app
COPY --chown=app:app requirements.txt .
RUN pip install --user -r requirements.txt
RUN python - <<'PY'
from sentence_transformers import SentenceTransformer
SentenceTransformer(
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    revision="e8f8c211226b894fcb81acc59f3b34ba3efd5f42",
)
PY

# Production application stage. GPU inference runs behind the private HTTP port.
FROM base AS production
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA \
      org.opencontainers.image.role=legacy-ai-runtime
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        libgomp1 \
        libmagic1 \
        poppler-utils \
        tesseract-ocr \
        tesseract-ocr-pol \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/cache/apt/archives/* \
    && rm -rf /tmp/*
USER app
COPY --from=dependencies-cpu --chown=app:app /home/app/.local /home/app/.local
ENV PATH=/home/app/.local/bin:$PATH
COPY --chown=app:app . .
RUN mkdir -p /app/data /app/logs /home/app/.cache/huggingface
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health/ready || exit 1
EXPOSE 8000
# Metrics, provider toggles and the loaded classifier are process-local. Keep one
# worker per container; scale with separate instances scraped by Prometheus.
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

# Private strong-host runtime: the audited heavy base plus minimal LlamaIndex mechanics.
FROM production AS knowledge-production
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA \
      org.opencontainers.image.role=knowledge-runtime
COPY --chown=app:app requirements-knowledge.txt .
RUN pip install --user -r requirements-knowledge.txt
USER root
RUN python -m pip uninstall -y setuptools wheel
USER app

# Development stage (optional)
FROM dependencies-cpu AS development
COPY --chown=app:app . .

# Install dev dependencies
RUN pip install --user \
    pytest \
    black \
    flake8 \
    mypy

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health/ready || exit 1

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
