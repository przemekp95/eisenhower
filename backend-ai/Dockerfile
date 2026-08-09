# Multi-stage build for Python AI service (CPU + CUDA targets)

# Shared base image for all build targets
FROM python:3.11-slim as base

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=on \
    PIP_DISABLE_PIP_VERSION_CHECK=on \
    PIP_DEFAULT_TIMEOUT=100 \
    HF_HOME=/home/app/.cache/huggingface \
    TORCH_CUDA_ALLOC_CONF=expandable_segments:True

WORKDIR /app

# Create non-root user
RUN useradd --create-home --shell /bin/bash app \
    && chown -R app:app /app
USER app

# ------------------------------------------------------------------------------
# Target: Dependencies (CPU - default build)
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
        tesseract-ocr \
        tesseract-ocr-pol \
        libtesseract-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/cache/apt/archives/* \
    && rm -rf /tmp/*

USER app
COPY --chown=app:app requirements.txt .
RUN pip install --user --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt
RUN python - <<'PY'
from sentence_transformers import SentenceTransformer
SentenceTransformer("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
PY

# ------------------------------------------------------------------------------
# Target: Dependencies (CUDA 12.4 - GPU-accelerated build)
# ------------------------------------------------------------------------------
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04 AS base-cuda

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=on \
    PIP_DISABLE_PIP_VERSION_CHECK=on \
    PIP_DEFAULT_TIMEOUT=100 \
    HF_HOME=/home/app/.cache/huggingface \
    TORCH_CUDA_ALLOC_CONF=expandable_segments:True \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility

WORKDIR /app

# Install Python 3.11 in the CUDA image
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3.11 \
        python3-pip \
        python3.11-venv \
        build-essential \
        curl \
        git \
        libffi-dev \
        libgomp1 \
        tesseract-ocr \
        tesseract-ocr-pol \
        libtesseract-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/cache/apt/archives/* \
    && rm -rf /tmp/* \
    && ln -s /usr/bin/python3.11 /usr/bin/python

# Create non-root user
RUN useradd --create-home --shell /bin/bash app \
    && chown -R app:app /app
USER app

FROM base-cuda AS dependencies-cuda
COPY --chown=app:app requirements.txt .
RUN pip install --user --extra-index-url https://download.pytorch.org/whl/cu124 -r requirements.txt
RUN python - <<'PY'
from sentence_transformers import SentenceTransformer
SentenceTransformer("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
PY

# Production stage
FROM base as production

# Install only runtime dependencies
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        libgomp1 \
        tesseract-ocr \
        tesseract-ocr-pol \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/cache/apt/archives/* \
    && rm -rf /tmp/*
USER app

COPY --from=dependencies-cpu --chown=app:app /home/app/.local /home/app/.local
ENV PATH=/home/app/.local/bin:$PATH

# Copy application code
COPY --chown=app:app . .

# Create data directory
RUN mkdir -p /app/data /app/logs /home/app/.cache/huggingface

# Health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/ || exit 1

# Expose port
EXPOSE 8000

# Start the application with multiple workers for production
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]

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
    CMD curl -f http://localhost:8000/ || exit 1

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
