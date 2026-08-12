FROM python:3.11-slim AS production

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app/backend-ai

WORKDIR /app/mcp

RUN useradd --create-home --uid 1001 --shell /usr/sbin/nologin app

COPY mcp/eisenhower_adapter/pyproject.toml ./pyproject.toml
COPY mcp/eisenhower_adapter/eisenhower_mcp ./eisenhower_mcp
RUN pip install --no-cache-dir .

COPY mcp/eisenhower_adapter/audit_runtime/__init__.py /app/backend-ai/app/__init__.py
COPY backend-ai/app/audit.py /app/backend-ai/app/audit.py
COPY mcp/eisenhower_adapter/docker-entrypoint.sh /usr/local/bin/eisenhower-mcp-entrypoint
RUN chmod 0755 /usr/local/bin/eisenhower-mcp-entrypoint \
    && mkdir -p /app/audit /run/eisenhower \
    && chown -R app:app /app/audit /run/eisenhower

USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import socket; socket.create_connection(('127.0.0.1', 8000), 3).close()"]
ENTRYPOINT ["eisenhower-mcp-entrypoint"]
