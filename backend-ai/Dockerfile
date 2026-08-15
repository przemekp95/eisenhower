# Role-specific CPU images. GPU inference remains a private external adapter.
FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=on \
    PIP_DISABLE_PIP_VERSION_CHECK=on \
    PIP_DEFAULT_TIMEOUT=100 \
    HF_HOME=/home/app/.cache/huggingface \
    TOKENIZERS_PARALLELISM=false

WORKDIR /app
RUN useradd --uid 1000 --create-home --shell /bin/bash app \
    && mkdir -p /app/data /app/logs /home/app/.cache/huggingface \
    && chown -R app:app /app /home/app
RUN pip install --no-cache-dir --upgrade setuptools==84.0.0 wheel==0.46.3

FROM base AS requirements-source
COPY requirements-boundary.txt requirements-ml.txt requirements-classifier.txt requirements-knowledge.txt requirements-ingest.txt requirements.txt ./

FROM requirements-source AS dependencies-boundary
USER app
RUN pip install --user -r requirements-boundary.txt

FROM dependencies-boundary AS dependencies-ml
USER app
RUN pip install --user -r requirements-ml.txt

FROM dependencies-ml AS dependencies-classifier
USER app
RUN pip install --user -r requirements-classifier.txt

FROM dependencies-ml AS dependencies-knowledge
USER app
RUN pip install --user -r requirements-knowledge.txt

FROM dependencies-knowledge AS dependencies-ingest
USER app
RUN pip install --user -r requirements-ingest.txt

FROM dependencies-boundary AS boundary
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA \
      eisenhower.runtime.role=boundary
ENV PATH=/home/app/.local/bin:$PATH
COPY --chown=app:app app ./app
USER app
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=3)"
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.api_boundary:from_environment", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

FROM dependencies-classifier AS classifier
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA \
      eisenhower.runtime.role=classifier
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 tesseract-ocr tesseract-ocr-pol \
    && rm -rf /var/lib/apt/lists/*
ENV PATH=/home/app/.local/bin:$PATH
COPY --chown=app:app . .
USER app
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=3)"
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

FROM dependencies-knowledge AS knowledge
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA \
      eisenhower.runtime.role=knowledge
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
ENV PATH=/home/app/.local/bin:$PATH
COPY --chown=app:app . .
USER app
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=3)"
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.knowledge_runtime:from_environment", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

FROM dependencies-ingest AS ingest
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA \
      eisenhower.runtime.role=ingest
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 libmagic1 poppler-utils tesseract-ocr tesseract-ocr-pol \
    && rm -rf /var/lib/apt/lists/*
ENV PATH=/home/app/.local/bin:$PATH
COPY --chown=app:app . .
USER app
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=5 \
  CMD python -c "from app.config import load_settings; from app.jobs import SqliteJobQueue; age=SqliteJobQueue(load_settings().jobs_database_path).latest_worker_heartbeat_age_seconds(); raise SystemExit(0 if age is not None and age < 60 else 1)"
CMD ["python", "-m", "app.worker_runtime"]

# Compatibility target for existing builders; it intentionally maps to classifier.
FROM classifier AS production

FROM dependencies-ingest AS development
COPY --chown=app:app . .
RUN pip install --user -r requirements-dev.txt
ENV PATH=/home/app/.local/bin:$PATH
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
