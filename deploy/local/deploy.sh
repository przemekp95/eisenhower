#!/bin/sh
set -eu

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
env_file="${EISENHOWER_LOCAL_ENV:-${root_dir}/deploy/local/.env}"
state_dir="${EISENHOWER_LOCAL_STATE_DIR:-${root_dir}/.runtime-cache/local-deploy}"
git_common_dir="$(git -C "$root_dir" rev-parse --path-format=absolute --git-common-dir)"
lifecycle_lock_dir="${EISENHOWER_LIFECYCLE_LOCK_DIR:-${git_common_dir}/eisenhower/runtime-locks}"
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
export AI_BOUNDARY_IMAGE="local/eisenhower-ai-boundary:${release_sha}"
export AI_CLASSIFIER_IMAGE="local/eisenhower-ai-classifier:${release_sha}"
export AI_KNOWLEDGE_IMAGE="local/eisenhower-ai-knowledge:${release_sha}"
export AI_INGEST_IMAGE="local/eisenhower-ai-ingest:${release_sha}"
export AI_ROCM_IMAGE="local/eisenhower-ai-rocm:${release_sha}"
export VLLM_RESPONSE_IMAGE="local/eisenhower-vllm-rocm:${release_sha}"
export MCP_IMAGE="local/eisenhower-mcp:${release_sha}"
export WEB_IMAGE="local/eisenhower-web:${release_sha}"
export LOCAL_MODEL_OWNER_APPROVAL_BYPASS=false

compose_base() {
  docker compose --env-file "$env_file" -f "$compose_base" "$@"
}

compose() {
  compose_full "$@"
}

compose_retrieval() {
  KNOWLEDGE_SERVICE_URL=http://knowledge-service:8000 \
  docker compose --env-file "$env_file" \
    -f "$compose_base" -f "$compose_amd" \
    --profile retrieval --profile retrieval-amd --profile reranker-amd "$@"
}

compose_response() {
  KNOWLEDGE_SERVICE_URL=http://knowledge-service:8000 \
  RAG_GENERATION_ENABLED=true RAG_RESPONSE_ENABLED=true \
  docker compose --env-file "$env_file" \
    -f "$compose_base" -f "$compose_amd" \
    --profile retrieval --profile response --profile access --profile identity --profile response-amd \
    --profile inference-amd --profile reranker-amd "$@"
}

compose_full() {
  KNOWLEDGE_SERVICE_URL=http://knowledge-service:8000 \
  RAG_GENERATION_ENABLED=true RAG_RESPONSE_ENABLED=true \
  docker compose --env-file "$env_file" \
    -f "$compose_base" -f "$compose_amd" \
    --profile full --profile retrieval-amd --profile response-amd \
    --profile inference-amd --profile reranker-amd "$@"
}

compose_legacy() {
  docker compose --env-file "$env_file" \
    -f "$state_dir/rollback.legacy.compose.yaml" \
    -f "$state_dir/rollback.legacy.compose.amd.yaml" \
    --profile retrieval-amd --profile response-amd \
    --profile inference-amd --profile reranker-amd "$@"
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

build_core_images() {
  docker build --build-arg RELEASE_SHA="$release_sha" --target production \
    -f backend-node/Dockerfile -t "$API_IMAGE" .
  docker build --build-arg RELEASE_SHA="$release_sha" --target boundary \
    -f backend-ai/Dockerfile -t "$AI_BOUNDARY_IMAGE" backend-ai
  docker build --build-arg RELEASE_SHA="$release_sha" --target classifier \
    -f backend-ai/Dockerfile -t "$AI_CLASSIFIER_IMAGE" backend-ai
  for image_ref in "$API_IMAGE" "$AI_BOUNDARY_IMAGE" "$AI_CLASSIFIER_IMAGE"; do
    verify_image "$image_ref"
  done
}

build_retrieval_images() {
  build_core_images
  docker build --build-arg RELEASE_SHA="$release_sha" --target knowledge \
    -f backend-ai/Dockerfile -t "$AI_KNOWLEDGE_IMAGE" backend-ai
  docker build --build-arg RELEASE_SHA="$release_sha" --target ingest \
    -f backend-ai/Dockerfile -t "$AI_INGEST_IMAGE" backend-ai
  docker build --build-arg RELEASE_SHA="$release_sha" \
    -f backend-ai/Dockerfile.rocm -t "$AI_ROCM_IMAGE" backend-ai
  for image_ref in "$AI_KNOWLEDGE_IMAGE" "$AI_INGEST_IMAGE" "$AI_ROCM_IMAGE"; do
    verify_image "$image_ref"
  done
}

build_response_images() {
  build_retrieval_images
  docker build --build-arg RELEASE_SHA="$release_sha" \
    -f backend-ai/Dockerfile.response-rocm -t "$VLLM_RESPONSE_IMAGE" backend-ai
  docker build --build-arg RELEASE_SHA="$release_sha" \
    -f mcp/eisenhower_adapter/Dockerfile -t "$MCP_IMAGE" .
  docker build --build-arg RELEASE_SHA="$release_sha" --target production \
    -f web/Dockerfile -t "$WEB_IMAGE" .
  for image_ref in "$VLLM_RESPONSE_IMAGE" "$MCP_IMAGE" "$WEB_IMAGE"; do
    verify_image "$image_ref"
  done
  response_image_id="$(docker image inspect "$VLLM_RESPONSE_IMAGE" --format '{{.Id}}')"
  case "$response_image_id" in
    sha256:[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
    *) echo "Response image has no immutable local image ID" >&2; exit 1 ;;
  esac
  export AMD_INFERENCE_IMAGE="$response_image_id"
  export AMD_RERANKER_IMAGE="$response_image_id"
}

build_images() {
  build_response_images
}

record_rollback() {
  requested_topology="${1:-full}"
  case "$requested_topology" in core|retrieval|response|full) ;; *)
    echo "Unknown rollback topology: $requested_topology" >&2; exit 1 ;;
  esac
  rollback_topology="$requested_topology"
  case "$rollback_topology" in
    core)
      rollback_compose=compose_base
      rollback_services="api-service ai-service classifier-service"
      ;;
    retrieval)
      rollback_compose=compose_retrieval
      rollback_services="api-service ai-service classifier-service knowledge-service rag-worker"
      ;;
    response)
      rollback_compose=compose_response
      rollback_services="api-service ai-service classifier-service knowledge-service rag-worker inference reranker mcp-service web"
      ;;
    full)
      rollback_compose=compose_full
      rollback_services="api-service ai-service classifier-service knowledge-service rag-worker inference reranker mcp-service web"
      ;;
  esac
  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  rollback_file="$state_dir/rollback.env"
  umask 077
  cp "$env_file" "$state_dir/rollback.config.env"
  chmod 600 "$state_dir/rollback.config.env"
  rollback_layout=roles
  classifier_container_id="$($rollback_compose ps -q classifier-service 2>/dev/null || true)"
  ai_container_id="$($rollback_compose ps -q ai-service 2>/dev/null || true)"
  if test -n "$ai_container_id" && test -z "$classifier_container_id"; then
    legacy_revision="$(docker inspect "$ai_container_id" \
      --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
    case "$legacy_revision" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]* ) ;;
      *) echo "Legacy AI image has no valid source revision" >&2; exit 1 ;;
    esac
    git cat-file -e "${legacy_revision}^{commit}"
    git show "${legacy_revision}:deploy/local/compose.yaml" \
      > "$state_dir/rollback.legacy.compose.yaml"
    git show "${legacy_revision}:deploy/local/compose.amd.yaml" \
      > "$state_dir/rollback.legacy.compose.amd.yaml"
    chmod 600 "$state_dir/rollback.legacy.compose.yaml" \
      "$state_dir/rollback.legacy.compose.amd.yaml"
    rollback_legacy_digest="$(
      sha256sum "$state_dir/rollback.legacy.compose.yaml" \
        "$state_dir/rollback.legacy.compose.amd.yaml" | sha256sum | awk '{print $1}'
    )"
    rollback_layout=legacy_monolith
    rollback_topology=full
    rollback_compose=compose_full
    rollback_services="api-service ai-service knowledge-service rag-worker inference reranker mcp-service web"
  else
    if test -n "$(compose_full ps -q n8n 2>/dev/null || true)"; then
      rollback_topology=full
      rollback_compose=compose_full
      rollback_services="api-service ai-service classifier-service knowledge-service rag-worker inference reranker mcp-service web"
    elif test -n "$(compose_response ps -q inference 2>/dev/null || true)" \
      || test -n "$(compose_response ps -q reranker 2>/dev/null || true)"; then
      rollback_topology=response
      rollback_compose=compose_response
      rollback_services="api-service ai-service classifier-service knowledge-service rag-worker inference reranker mcp-service web"
    elif test -n "$(compose_retrieval ps -q knowledge-service 2>/dev/null || true)" \
      || test -n "$(compose_retrieval ps -q rag-worker 2>/dev/null || true)"; then
      rollback_topology=retrieval
      rollback_compose=compose_retrieval
      rollback_services="api-service ai-service classifier-service knowledge-service rag-worker"
    else
      rollback_topology=core
      rollback_compose=compose_base
      rollback_services="api-service ai-service classifier-service"
    fi
  fi
  {
    echo "ROLLBACK_RECORDED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "ROLLBACK_TOPOLOGY=$rollback_topology"
    if test "$rollback_layout" = legacy_monolith; then
      echo "ROLLBACK_LAYOUT=legacy_monolith"
      echo "ROLLBACK_RELEASE_SHA=$legacy_revision"
      echo "ROLLBACK_LEGACY_COMPOSE_SHA256=$rollback_legacy_digest"
    else
      echo "ROLLBACK_LAYOUT=roles"
    fi
    for service in $rollback_services; do
      container_id="$($rollback_compose ps -q "$service" 2>/dev/null || true)"
      test -n "$container_id" || {
        echo "Cannot record complete rollback: $service is not running" >&2
        exit 1
      }
      image_id="$(docker inspect "$container_id" --format '{{.Image}}')"
      key="$(echo "$service" | tr 'a-z-' 'A-Z_')"
      echo "ROLLBACK_${key}_IMAGE_ID=${image_id}"
    done
  } > "$rollback_file"
}

validate_runtime_inputs() {
  test -n "${INFERENCE_API_KEY:-}" || { echo "INFERENCE_API_KEY is required" >&2; exit 1; }
  test -n "${INFERENCE_MODEL:-}" || { echo "INFERENCE_MODEL is required" >&2; exit 1; }
  test -n "${INFERENCE_MODEL_REVISION:-}" || { echo "INFERENCE_MODEL_REVISION is required" >&2; exit 1; }
  test -n "${RERANKER_API_KEY:-}" || { echo "RERANKER_API_KEY is required" >&2; exit 1; }
  validate_classifier_approval
}

validate_classifier_approval() {
  artifact_pointer="${AI_CLASSIFIER_ARTIFACT_ROOT:-}/local_minilm_current.json"
  test -f "$artifact_pointer" || {
    echo "Approved classifier generation pointer is required" >&2
    exit 1
  }
  artifact_digest="$(sha256sum "$artifact_pointer" | awk '{print $1}')"
  test "$artifact_digest" = "${LOCAL_MODEL_APPROVED_ARTIFACT_SHA256:-}" || {
    echo "Classifier generation pointer digest mismatch" >&2
    exit 1
  }
  if test "${AI_EVALUATION_FILE:-}" != "/dev/null" && test -f "${AI_EVALUATION_FILE:-}"; then
    actual_digest="$(sha256sum "$AI_EVALUATION_FILE" | awk '{print $1}')"
    test "$actual_digest" = "${LOCAL_MODEL_APPROVED_EVALUATION_SHA256:-}" || {
      echo "Production evaluation digest mismatch" >&2
      exit 1
    }
    export LOCAL_MODEL_OWNER_APPROVAL_BYPASS=false
    return
  fi

  approval_deadline="${LOCAL_MODEL_OWNER_APPROVAL_VALID_UNTIL:-}"
  test -n "$approval_deadline" || {
    echo "A real production evaluation or time-bounded owner approval is required" >&2
    exit 1
  }
  approval_epoch="$(date -d "$approval_deadline" +%s 2>/dev/null)" || {
    echo "Owner approval deadline must be a valid ISO-8601 timestamp" >&2
    exit 1
  }
  test "$approval_epoch" -gt "$(date +%s)" || {
    echo "Owner approval has expired" >&2
    exit 1
  }
  export LOCAL_MODEL_OWNER_APPROVAL_BYPASS=true
}

validate_core_inputs() {
  validate_classifier_approval
}

validate_docling_approval() {
  docling_manifest="${AI_DOCLING_ARTIFACT_ROOT:-}/manifest.json"
  test -f "$docling_manifest" || {
    echo "Approved Docling artifact manifest is required" >&2
    exit 1
  }
  docling_digest="$(sha256sum "$docling_manifest" | awk '{print $1}')"
  test "$docling_digest" = "${DOCLING_ARTIFACTS_MANIFEST_SHA256:-}" || {
    echo "Docling artifact manifest digest mismatch" >&2
    exit 1
  }
}

validate_retrieval_inputs() {
  validate_core_inputs
  validate_docling_approval
  test -n "${RERANKER_API_KEY:-}" || { echo "RERANKER_API_KEY is required" >&2; exit 1; }
  test -n "${RAG_ALLOWED_TENANTS:-}" || { echo "RAG_ALLOWED_TENANTS is required" >&2; exit 1; }
}

validate_response_inputs() {
  test -n "${INFERENCE_API_KEY:-}" || { echo "INFERENCE_API_KEY is required" >&2; exit 1; }
  test -n "${INFERENCE_MODEL:-}" || { echo "INFERENCE_MODEL is required" >&2; exit 1; }
  test -n "${INFERENCE_MODEL_REVISION:-}" || { echo "INFERENCE_MODEL_REVISION is required" >&2; exit 1; }
  test -n "${RERANKER_API_KEY:-}" || { echo "RERANKER_API_KEY is required" >&2; exit 1; }
  test -n "${RAG_RESPONSE_CANDIDATE_ID:-}" || { echo "RAG_RESPONSE_CANDIDATE_ID is required" >&2; exit 1; }
  test -n "${RAG_ALLOWED_TENANTS:-}" || { echo "RAG_ALLOWED_TENANTS is required" >&2; exit 1; }
  test -n "${RAG_RESPONSE_ALLOWED_USERS:-}" || { echo "RAG_RESPONSE_ALLOWED_USERS is required" >&2; exit 1; }
  test -f "${AI_PROMOTION_ROOT:-}/current.json" || {
    echo "AI promotion pointer is required" >&2
    exit 1
  }
}

validate_response_stack_inputs() {
  validate_retrieval_inputs
  validate_response_inputs
}

configure_identity_profile() {
  # Forward the current owner-only environment explicitly. The long-lived
  # Keycloak container may still carry bootstrap credentials from an older
  # deployment even though the local .env has been rotated.
  compose_base exec -T \
    -e KC_BOOTSTRAP_ADMIN_USERNAME \
    -e KC_BOOTSTRAP_ADMIN_PASSWORD \
    identity-service sh -eu -c '
    kcadm=/opt/keycloak/bin/kcadm.sh
    attempt=1
    until "$kcadm" config credentials \
        --server http://127.0.0.1:8080/identity \
        --realm master \
        --user "$KC_BOOTSTRAP_ADMIN_USERNAME" \
        --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null 2>&1; do
      test "$attempt" -lt 30 || {
        echo "Keycloak Admin API did not become ready" >&2
        exit 1
      }
      attempt=$((attempt + 1))
      sleep 2
    done
    # Keep authentication in the master realm. With Keycloak 26, `-r
    # eisenhower` also changes the kcadm authorization context and rejects
    # this cross-realm profile write even for the master administrator.
    "$kcadm" update \
      http://127.0.0.1:8080/identity/admin/realms/eisenhower/users/profile \
      -f /opt/keycloak/conf/eisenhower-user-profile.json
  '
}

render() {
  compose_base config --quiet
  compose_retrieval config --quiet
  compose_response config --quiet
  compose_full config --quiet
}

validate_lifecycle_auth() {
  test -n "${LIFECYCLE_OPERATOR_TOKEN:-}" || {
    echo "LIFECYCLE_OPERATOR_TOKEN is required" >&2
    exit 1
  }
  test -n "${EISENHOWER_LIFECYCLE_TOKEN:-}" || {
    echo "EISENHOWER_LIFECYCLE_TOKEN is required" >&2
    exit 1
  }
  export LIFECYCLE_OPERATOR_TOKEN EISENHOWER_LIFECYCLE_TOKEN
  python3 - <<'PY'
import hmac
import os
import sys

if not hmac.compare_digest(
    os.environ["LIFECYCLE_OPERATOR_TOKEN"],
    os.environ["EISENHOWER_LIFECYCLE_TOKEN"],
):
    sys.exit("Lifecycle authorization failed")
PY
}

sleep_response() {
  validate_lifecycle_auth
  acquire_response_lifecycle_lock
  compose_response stop inference reranker
}

acquire_response_lifecycle_lock() {
  lock_timeout="${LIFECYCLE_LOCK_TIMEOUT_SECONDS:-30}"
  case "$lock_timeout" in *[!0-9]*|'') echo "Lifecycle lock timeout must be a positive integer" >&2; return 1 ;; esac
  test "$lock_timeout" -gt 0 || { echo "Lifecycle lock timeout must be positive" >&2; return 1; }
  umask 077
  mkdir -p "$lifecycle_lock_dir"
  chmod 700 "$lifecycle_lock_dir"
  exec 9>"$lifecycle_lock_dir/response.lock"
  flock -w "$lock_timeout" 9 || {
    echo "Another response lifecycle operation is still running" >&2
    return 1
  }
}

wait_for_response_service() {
  service="$1"
  deadline="$2"
  while test "$(date +%s)" -lt "$deadline"; do
    if compose_response exec -T "$service" sh -c \
      'curl --connect-timeout 2 --max-time 5 -fsS -H "Authorization: Bearer $VLLM_API_KEY" http://127.0.0.1:8000/v1/models >/dev/null'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wake_response() {
  validate_lifecycle_auth
  validate_response_inputs
  acquire_response_lifecycle_lock
  timeout_seconds="${INFERENCE_WAKE_TIMEOUT_SECONDS:?INFERENCE_WAKE_TIMEOUT_SECONDS is required}"
  case "$timeout_seconds" in *[!0-9]*|'') echo "Wake timeout must be a positive integer" >&2; exit 1 ;; esac
  test "$timeout_seconds" -gt 0 || { echo "Wake timeout must be positive" >&2; exit 1; }
  deadline=$(( $(date +%s) + timeout_seconds ))
  # Preserve exact stopped containers/images and serialize cold-load. Physical
  # gfx1151 evidence showed that simultaneous model loading can starve Qwen.
  if ! compose_response start reranker; then
    if ! compose_response up --no-deps -d reranker; then
      compose_response stop inference reranker || true
      return 1
    fi
  fi
  wait_for_response_service reranker "$deadline" || {
    echo "Reranker cold wake timed out; stopping partial runtime" >&2
    compose_response stop inference reranker || true
    return 1
  }
  if ! compose_response start inference; then
    if ! compose_response up --no-deps -d inference; then
      compose_response stop inference reranker || true
      return 1
    fi
  fi
  if wait_for_response_service inference "$deadline"; then
    return 0
  fi
  echo "Response runtime cold wake timed out; stopping partial runtime" >&2
  compose_response stop inference reranker || true
  return 1
}

smoke() {
  compose ps
  curl -fsS "http://127.0.0.1:${ACCESS_GATEWAY_BIND_PORT:-8790}/" \
    -H "Host: ${ACCESS_GATEWAY_HOST}" >/dev/null
  curl -fsS "http://127.0.0.1:${NODE_BIND_PORT:-3001}/health/ready" >/dev/null
  curl -fsS "http://127.0.0.1:${AI_BIND_PORT:-8000}/health/ready" >/dev/null
  curl -fsS "http://127.0.0.1:${INFERENCE_BIND_PORT:-8010}/v1/models" \
    -H "Authorization: Bearer ${INFERENCE_API_KEY}" >/dev/null
}

smoke_core() {
  compose_base ps mongodb ai-service classifier-service api-service
  curl -fsS "http://127.0.0.1:${NODE_BIND_PORT:-3001}/health/ready" >/dev/null
  curl -fsS "http://127.0.0.1:${AI_BIND_PORT:-8000}/health/ready" >/dev/null
}

smoke_retrieval() {
  smoke_core
  compose_retrieval ps qdrant knowledge-service rag-worker reranker
  compose_retrieval exec -T knowledge-service \
    curl -fsS http://127.0.0.1:8000/health/ready >/dev/null
  compose_retrieval exec -T reranker sh -c \
    'curl -fsS -H "Authorization: Bearer $VLLM_API_KEY" http://127.0.0.1:8000/v1/models >/dev/null'
}

smoke_response() {
  compose_response ps knowledge-service access-gateway
  compose_response exec -T knowledge-service curl -fsS http://127.0.0.1:8000/health/live >/dev/null
}

deploy_core() {
  validate_core_inputs
  build_core_images
  compose_base config --quiet
  record_rollback core
  compose_base up --no-deps audit-volume-init
  compose_base up -d --wait mongodb
  compose_base up --no-deps -d --wait classifier-service
  compose_base up --no-deps -d --wait ai-service api-service
  smoke_core
}

deploy_retrieval() {
  validate_retrieval_inputs
  build_retrieval_images
  compose_retrieval config --quiet
  record_rollback retrieval
  compose_retrieval up --no-deps audit-volume-init
  compose_retrieval up -d --wait mongodb qdrant
  compose_retrieval up --no-deps -d --wait reranker
  compose_retrieval up --no-deps -d --wait knowledge-service classifier-service
  compose_retrieval up --no-deps -d --wait ai-service api-service
  compose_retrieval up --no-deps -d rag-worker
  smoke_retrieval
}

deploy_response() {
  validate_response_stack_inputs
  build_response_images
  compose_response config --quiet
  record_rollback response
  compose_response up --no-deps audit-volume-init
  compose_response up -d --wait mongodb qdrant identity-db identity-service
  configure_identity_profile
  compose_response up --no-deps -d --wait inference reranker
  compose_response up --no-deps -d --wait knowledge-service classifier-service
  compose_response up --no-deps -d --wait ai-service api-service web mcp-service
  compose_response up --no-deps -d rag-worker
  compose_response up --no-deps -d --wait access-gateway
  smoke_response
}

deploy_full() {
  validate_runtime_inputs
  build_images
  render
  record_rollback full
  compose_base up --no-deps audit-volume-init
  compose_base up -d --wait mongodb qdrant identity-db identity-service n8n
  configure_identity_profile
  compose up --no-deps -d --wait inference reranker
  compose up --no-deps -d --wait knowledge-service
  compose_full up --no-deps -d --wait ai-service classifier-service api-service web mcp-service
  compose_full up --no-deps -d rag-worker
  compose_full up --no-deps -d --wait access-gateway calendar-gateway
  smoke
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
  env_file="$rollback_config"
  export API_IMAGE="${ROLLBACK_API_SERVICE_IMAGE_ID:?missing API rollback image}"
  case "${ROLLBACK_LAYOUT:-roles}" in
    legacy_monolith)
      legacy_base="$state_dir/rollback.legacy.compose.yaml"
      legacy_amd="$state_dir/rollback.legacy.compose.amd.yaml"
      test -f "$legacy_base" && test -f "$legacy_amd" || {
        echo "Legacy rollback Compose snapshot is incomplete" >&2
        exit 1
      }
      actual_legacy_digest="$(
        sha256sum "$legacy_base" "$legacy_amd" | sha256sum | awk '{print $1}'
      )"
      test "$actual_legacy_digest" = "${ROLLBACK_LEGACY_COMPOSE_SHA256:-}" || {
        echo "Legacy rollback Compose digest mismatch" >&2
        exit 1
      }
      export RELEASE_SHA="${ROLLBACK_RELEASE_SHA:?missing legacy release SHA}"
      export AI_ROCM_RELEASE_SHA="$RELEASE_SHA"
      export AI_IMAGE="${ROLLBACK_AI_SERVICE_IMAGE_ID:?missing legacy AI rollback image}"
      export AI_ROCM_IMAGE="${ROLLBACK_KNOWLEDGE_SERVICE_IMAGE_ID:-$AI_IMAGE}"
      export AMD_INFERENCE_IMAGE="${ROLLBACK_INFERENCE_IMAGE_ID:?missing legacy inference rollback image}"
      export AMD_RERANKER_IMAGE="${ROLLBACK_RERANKER_IMAGE_ID:?missing legacy reranker rollback image}"
      export MCP_IMAGE="${ROLLBACK_MCP_SERVICE_IMAGE_ID:?missing MCP rollback image}"
      export WEB_IMAGE="${ROLLBACK_WEB_IMAGE_ID:?missing web rollback image}"
      compose_legacy config --quiet
      compose_legacy up -d --wait
      compose_legacy ps
      curl -fsS "http://127.0.0.1:${NODE_BIND_PORT:-3001}/health/ready" >/dev/null
      curl -fsS "http://127.0.0.1:${AI_BIND_PORT:-8000}/health/ready" >/dev/null
      compose_legacy exec -T knowledge-service \
        curl -fsS http://127.0.0.1:8000/health/live >/dev/null
      return 0
      ;;
    roles) ;;
    *) echo "Unknown rollback layout: $ROLLBACK_LAYOUT" >&2; exit 1 ;;
  esac
  export AI_BOUNDARY_IMAGE="${ROLLBACK_AI_SERVICE_IMAGE_ID:?missing AI boundary rollback image}"
  export AI_CLASSIFIER_IMAGE="${ROLLBACK_CLASSIFIER_SERVICE_IMAGE_ID:?missing classifier rollback image}"
  case "${ROLLBACK_TOPOLOGY:?missing rollback topology}" in
    core)
      compose_full stop knowledge-service rag-worker inference reranker mcp-service web >/dev/null 2>&1 || true
      compose_base config --quiet
      compose_base up -d --wait
      smoke_core
      ;;
    retrieval)
      export AI_KNOWLEDGE_IMAGE="${ROLLBACK_KNOWLEDGE_SERVICE_IMAGE_ID:?missing knowledge rollback image}"
      export AI_INGEST_IMAGE="${ROLLBACK_RAG_WORKER_IMAGE_ID:?missing ingest rollback image}"
      export AI_ROCM_IMAGE="$AI_KNOWLEDGE_IMAGE"
      compose_full stop inference mcp-service web >/dev/null 2>&1 || true
      compose_retrieval config --quiet
      compose_retrieval up -d --wait
      smoke_retrieval
      ;;
    response|full)
      export AI_KNOWLEDGE_IMAGE="${ROLLBACK_KNOWLEDGE_SERVICE_IMAGE_ID:?missing knowledge rollback image}"
      export AI_INGEST_IMAGE="${ROLLBACK_RAG_WORKER_IMAGE_ID:?missing ingest rollback image}"
      export AI_ROCM_IMAGE="$AI_KNOWLEDGE_IMAGE"
      export AMD_INFERENCE_IMAGE="${ROLLBACK_INFERENCE_IMAGE_ID:?missing inference rollback image}"
      export AMD_RERANKER_IMAGE="${ROLLBACK_RERANKER_IMAGE_ID:?missing reranker rollback image}"
      export MCP_IMAGE="${ROLLBACK_MCP_SERVICE_IMAGE_ID:?missing MCP rollback image}"
      export WEB_IMAGE="${ROLLBACK_WEB_IMAGE_ID:?missing web rollback image}"
      if test "$ROLLBACK_TOPOLOGY" = response; then
        compose_response config --quiet
        compose_response up -d --wait
        configure_identity_profile
        smoke_response
      else
        compose_full config --quiet
        compose_full up -d --wait
        configure_identity_profile
        smoke
      fi
      ;;
    *) echo "Unknown rollback topology: $ROLLBACK_TOPOLOGY" >&2; exit 1 ;;
  esac
}

case "$action" in
  build) build_images ;;
  render) render ;;
  render-core) compose_base config --quiet ;;
  render-retrieval) compose_retrieval config --quiet ;;
  render-response) compose_response config --quiet ;;
  render-full) compose_full config --quiet ;;
  deploy) deploy_core ;;
  deploy-core) deploy_core ;;
  deploy-retrieval) deploy_retrieval ;;
  deploy-response) deploy_response ;;
  deploy-full) deploy_full ;;
  smoke)
    validate_runtime_inputs
    render
    smoke
    ;;
  sleep-response) sleep_response ;;
  wake-response) wake_response ;;
  rollback) rollback ;;
  *)
    echo "Usage: $0 {build|render|render-core|render-retrieval|render-response|render-full|deploy|deploy-core|deploy-retrieval|deploy-response|deploy-full|sleep-response|wake-response|smoke|rollback}" >&2
    exit 2
    ;;
esac
