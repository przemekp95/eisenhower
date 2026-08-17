FROM cgr.dev/chainguard/wolfi-base@sha256:0a8fd427de5882aed77471b0a432c3675eda6b6a0ae952b5d640b46da628cdbe AS builder

ENV PIP_NO_CACHE_DIR=on \
    PIP_DISABLE_PIP_VERSION_CHECK=on

WORKDIR /app/mcp
RUN apk add --no-cache \
      python-3.11=3.11.16-r1 \
      py3.11-pip=26.2.1-r0 \
    && mkdir -p /opt/python

COPY mcp/eisenhower_adapter/pyproject.toml ./pyproject.toml
COPY mcp/eisenhower_adapter/eisenhower_mcp ./eisenhower_mcp
RUN python3.11 -m pip install --target /opt/python .

FROM cgr.dev/chainguard/wolfi-base@sha256:0a8fd427de5882aed77471b0a432c3675eda6b6a0ae952b5d640b46da628cdbe AS production

ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/opt/python:/app/backend-ai

WORKDIR /app/mcp
USER root
RUN apk add --no-cache python-3.11=3.11.16-r1 \
    && mkdir -p /app/audit /app/backend-ai/app /run/eisenhower \
    && chown -R 65532:65532 /app /run/eisenhower

COPY --from=builder --chown=65532:65532 /opt/python /opt/python
COPY --chown=65532:65532 mcp/eisenhower_adapter/audit_runtime/__init__.py /app/backend-ai/app/__init__.py
COPY --chown=65532:65532 backend-ai/app/audit.py /app/backend-ai/app/audit.py
COPY --chown=65532:65532 mcp/eisenhower_adapter/docker-entrypoint.sh /usr/local/bin/eisenhower-mcp-entrypoint
RUN chmod 0755 /usr/local/bin/eisenhower-mcp-entrypoint

USER 65532:65532
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python3.11", "-c", "import socket; socket.create_connection(('127.0.0.1', 8000), 3).close()"]
ENTRYPOINT ["eisenhower-mcp-entrypoint"]
