#!/bin/sh
set -eu

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
env_file="${EISENHOWER_LOCAL_ENV:-${root_dir}/deploy/local/.env}"
state_dir="${EISENHOWER_LOCAL_STATE_DIR:-${root_dir}/.runtime-cache/local-deploy}"
compose_base="${root_dir}/deploy/local/compose.yaml"
compose_amd="${root_dir}/deploy/local/compose.amd.yaml"
action="${1:-render}"

cd "$root_dir"
test -f "$env_file" || { echo "Missing owner-only environment: $env_file" >&2; exit 1; }
test "$(stat -c '%a' "$env_file")" = "600" || {
  echo "Environment must have mode 600" >&2
  exit 1
}
git diff --quiet
git diff --cached --quiet
release_sha="$(git rev-parse HEAD)"

set -a
. "$env_file"
set +a
export RELEASE_SHA="$release_sha"
export AI_ROCM_RELEASE_SHA="$release_sha"
export API_IMAGE="local/eisenhower-api:${release_sha}"
export AI_IMAGE="local/eisenhower-ai:${release_sha}"
export AI_ROCM_IMAGE="local/eisenhower-ai-rocm:${release_sha}"
export MCP_IMAGE="local/eisenhower-mcp:${release_sha}"
export WEB_IMAGE="local/eisenhower-web:${release_sha}"

compose() {
  docker compose --env-file "$env_file" \
    -f "$compose_base" -f "$compose_amd" \
    --profile retrieval-amd --profile response-amd --profile inference-amd --profile reranker-amd "$@"
}

verify_image() {
  image_ref="$1"
  image_revision="$(docker image inspect "$image_ref" \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  test "$image_revision" = "$release_sha" || {
    echo "Image revision mismatch: $image_ref ($image_revision != $release_sha)" >&2
    exit 1
  }
}

build_images() {
  docker build --build-arg RELEASE_SHA="$release_sha" --target production \
    -f backend-node/Dockerfile -t "$API_IMAGE" .
  docker build --build-arg RELEASE_SHA="$release_sha" --target production \
    -f backend-ai/Dockerfile -t "$AI_IMAGE" backend-ai
  docker build --build-arg RELEASE_SHA="$release_sha" \
    -f backend-ai/Dockerfile.rocm -t "$AI_ROCM_IMAGE" backend-ai
  docker build --build-arg RELEASE_SHA="$release_sha" \
    -f mcp/eisenhower_adapter/Dockerfile -t "$MCP_IMAGE" .
  docker build --build-arg RELEASE_SHA="$release_sha" --target production \
    -f web/Dockerfile -t "$WEB_IMAGE" .
  for image_ref in "$API_IMAGE" "$AI_IMAGE" "$AI_ROCM_IMAGE" "$MCP_IMAGE" "$WEB_IMAGE"; do
    verify_image "$image_ref"
  done
}

record_rollback() {
  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  rollback_file="$state_dir/rollback.env"
  umask 077
  cp "$env_file" "$state_dir/rollback.config.env"
  chmod 600 "$state_dir/rollback.config.env"
  {
    echo "ROLLBACK_RECORDED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for service in api-service ai-service knowledge-service rag-worker mcp-service web; do
      container_id="$(compose ps -q "$service" 2>/dev/null || true)"
      if test -n "$container_id"; then
        image_id="$(docker inspect "$container_id" --format '{{.Image}}')"
        key="$(echo "$service" | tr 'a-z-' 'A-Z_')"
        echo "ROLLBACK_${key}_IMAGE_ID=${image_id}"
      fi
    done
  } > "$rollback_file"
}

validate_runtime_inputs() {
  test -n "${INFERENCE_API_KEY:-}" || { echo "INFERENCE_API_KEY is required" >&2; exit 1; }
  test -n "${INFERENCE_MODEL:-}" || { echo "INFERENCE_MODEL is required" >&2; exit 1; }
  test -n "${INFERENCE_MODEL_REVISION:-}" || { echo "INFERENCE_MODEL_REVISION is required" >&2; exit 1; }
  test -n "${RERANKER_API_KEY:-}" || { echo "RERANKER_API_KEY is required" >&2; exit 1; }
  test "${AI_EVALUATION_FILE:-}" != "/dev/null" && test -f "${AI_EVALUATION_FILE:-}" || {
    echo "A real production AI_EVALUATION_FILE is required" >&2
    exit 1
  }
  actual_digest="$(sha256sum "$AI_EVALUATION_FILE" | awk '{print $1}')"
  test "$actual_digest" = "${LOCAL_MODEL_APPROVED_EVALUATION_SHA256:-}" || {
    echo "Production evaluation digest mismatch" >&2
    exit 1
  }
}

validate_response_inputs() {
  test -n "${INFERENCE_API_KEY:-}" || { echo "INFERENCE_API_KEY is required" >&2; exit 1; }
  test -n "${INFERENCE_MODEL:-}" || { echo "INFERENCE_MODEL is required" >&2; exit 1; }
  test -n "${RERANKER_API_KEY:-}" || { echo "RERANKER_API_KEY is required" >&2; exit 1; }
  test -n "${RAG_RESPONSE_CANDIDATE_ID:-}" || { echo "RAG_RESPONSE_CANDIDATE_ID is required" >&2; exit 1; }
  test -n "${RAG_ALLOWED_TENANTS:-}" || { echo "RAG_ALLOWED_TENANTS is required" >&2; exit 1; }
  test -n "${RAG_RESPONSE_ALLOWED_USERS:-}" || { echo "RAG_RESPONSE_ALLOWED_USERS is required" >&2; exit 1; }
  test -f "${AI_PROMOTION_ROOT:-}/current.json" || {
    echo "AI promotion pointer is required" >&2
    exit 1
  }
}

render() {
  compose config --quiet
}

smoke() {
  compose ps
  curl -fsS "http://127.0.0.1:${ACCESS_GATEWAY_BIND_PORT:-8790}/" \
    -H "Host: ${ACCESS_GATEWAY_HOST}" >/dev/null
  curl -fsS "http://127.0.0.1:${NODE_BIND_PORT:-3001}/health/ready" >/dev/null
  curl -fsS "http://127.0.0.1:${AI_BIND_PORT:-8000}/health/live" >/dev/null
  curl -fsS "http://127.0.0.1:${INFERENCE_BIND_PORT:-8010}/v1/models" \
    -H "Authorization: Bearer ${INFERENCE_API_KEY}" >/dev/null
}

smoke_response() {
  compose ps knowledge-service access-gateway
  compose exec -T knowledge-service curl -fsS http://127.0.0.1:8000/health/live >/dev/null
}

rollback() {
  rollback_file="$state_dir/rollback.env"
  rollback_config="$state_dir/rollback.config.env"
  test -f "$rollback_file" && test -f "$rollback_config" || {
    echo "No complete rollback set is available" >&2
    exit 1
  }
  set -a
  . "$rollback_config"
  . "$rollback_file"
  set +a
  export API_IMAGE="${ROLLBACK_API_SERVICE_IMAGE_ID:?missing API rollback image}"
  export AI_IMAGE="${ROLLBACK_AI_SERVICE_IMAGE_ID:?missing AI rollback image}"
  export AI_ROCM_IMAGE="$AI_IMAGE"
  export MCP_IMAGE="${ROLLBACK_MCP_SERVICE_IMAGE_ID:?missing MCP rollback image}"
  export WEB_IMAGE="${ROLLBACK_WEB_IMAGE_ID:?missing web rollback image}"
  compose config --quiet
  compose up -d --wait
  smoke
}

case "$action" in
  build) build_images ;;
  render) render ;;
  deploy)
    validate_runtime_inputs
    build_images
    render
    record_rollback
    compose up -d --wait
    smoke
    ;;
  deploy-response)
    validate_response_inputs
    docker build --build-arg RELEASE_SHA="$release_sha" \
      -f backend-ai/Dockerfile.rocm -t "$AI_ROCM_IMAGE" backend-ai
    verify_image "$AI_ROCM_IMAGE"
    render
    record_rollback
    compose up --no-deps -d --wait inference reranker
    compose up --no-deps -d --wait knowledge-service access-gateway
    smoke_response
    ;;
  smoke)
    validate_runtime_inputs
    render
    smoke
    ;;
  rollback) rollback ;;
  *)
    echo "Usage: $0 {build|render|deploy|deploy-response|smoke|rollback}" >&2
    exit 2
    ;;
esac
