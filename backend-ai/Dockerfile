# Role-specific CPU images. GPU inference remains a private external adapter.
# Wolfi packages keep the complete runtime inventory visible to Trivy and SBOM tooling.
FROM cgr.dev/chainguard/wolfi-base@sha256:0a8fd427de5882aed77471b0a432c3675eda6b6a0ae952b5d640b46da628cdbe AS python-builder

ENV PIP_NO_CACHE_DIR=on \
    PIP_DISABLE_PIP_VERSION_CHECK=on \
    PIP_DEFAULT_TIMEOUT=100

WORKDIR /app
RUN apk add --no-cache \
      python-3.11=3.11.16-r1 \
      py3.11-pip=26.2.1-r0 \
    && mkdir -p /opt/python

FROM python-builder AS requirements-source
COPY requirements-boundary.txt requirements-ml.txt requirements-classifier.txt requirements-knowledge.txt requirements-ingest.txt requirements.txt ./

FROM requirements-source AS dependencies-boundary
RUN python3.11 -m pip install --target /opt/python --requirement requirements-boundary.txt

FROM dependencies-boundary AS dependencies-ml
RUN python3.11 -m pip install --target /opt/python --upgrade --requirement requirements-ml.txt

FROM dependencies-ml AS dependencies-classifier
RUN python3.11 -m pip install --target /opt/python --upgrade --requirement requirements-classifier.txt

FROM dependencies-ml AS dependencies-knowledge
RUN python3.11 -m pip install --target /opt/python --upgrade --requirement requirements-knowledge.txt

FROM dependencies-knowledge AS dependencies-ingest
RUN python3.11 -m pip install --target /opt/python --upgrade --requirement requirements-ingest.txt

FROM cgr.dev/chainguard/wolfi-base@sha256:0a8fd427de5882aed77471b0a432c3675eda6b6a0ae952b5d640b46da628cdbe AS runtime-base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/opt/python \
    HF_HOME=/home/app/.cache/huggingface \
    TOKENIZERS_PARALLELISM=false

WORKDIR /app
USER root
RUN apk add --no-cache python-3.11=3.11.16-r1 \
    && mkdir -p /app/data /app/logs /home/app/.cache/huggingface \
    && chown -R 65532:65532 /app /home/app

FROM runtime-base AS boundary
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA \
      eisenhower.runtime.role=boundary
COPY --from=dependencies-boundary /opt/python /opt/python
COPY --chown=65532:65532 app ./app
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python3.11 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=3)"
EXPOSE 8000
CMD ["python3.11", "-m", "uvicorn", "app.api_boundary:from_environment", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

FROM runtime-base AS classifier
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA \
      eisenhower.runtime.role=classifier
USER root
RUN apk add --no-cache \
      libgomp=16.1.0-r4 \
      tesseract=5.5.2-r8 \
      tesseract-eng=5.5.2-r8 \
      tesseract-osd=5.5.2-r8 \
      tesseract-pol=5.5.2-r8
COPY --from=dependencies-classifier /opt/python /opt/python
COPY --chown=65532:65532 . .
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD python3.11 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=3)"
EXPOSE 8000
CMD ["python3.11", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

FROM runtime-base AS knowledge
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA \
      eisenhower.runtime.role=knowledge
USER root
RUN apk add --no-cache libgomp=16.1.0-r4
COPY --from=dependencies-knowledge /opt/python /opt/python
COPY --chown=65532:65532 . .
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=5 \
  CMD python3.11 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=3)"
EXPOSE 8000
CMD ["python3.11", "-m", "uvicorn", "app.knowledge_runtime:from_environment", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

FROM runtime-base AS ingest
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA \
      eisenhower.runtime.role=ingest
USER root
RUN apk add --no-cache \
      libgomp=16.1.0-r4 \
      libmagic=5.48-r1 \
      mesa-gl=26.2.0-r0 \
      poppler-utils=26.08.0-r0 \
      tesseract=5.5.2-r8 \
      tesseract-eng=5.5.2-r8 \
      tesseract-osd=5.5.2-r8 \
      tesseract-pol=5.5.2-r8
COPY --from=dependencies-ingest /opt/python /opt/python
COPY --chown=65532:65532 . .
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=5 \
  CMD python3.11 -c "from app.config import load_settings; from app.jobs import SqliteJobQueue; age=SqliteJobQueue(load_settings().jobs_database_path).latest_worker_heartbeat_age_seconds(); raise SystemExit(0 if age is not None and age < 60 else 1)"
CMD ["python3.11", "-m", "app.worker_runtime"]

# Compatibility target for existing builders; it intentionally maps to classifier.
FROM classifier AS production

FROM dependencies-ingest AS development
COPY --chown=65532:65532 . .
RUN python3.11 -m pip install --target /opt/python --upgrade --requirement requirements-dev.txt
ENV PYTHONPATH=/opt/python
USER 65532:65532
CMD ["python3.11", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
