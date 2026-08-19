#!/usr/bin/env bash
set -euo pipefail

test "$#" -eq 2 || test "$#" -eq 3 || {
  echo "Usage: deploy.sh RELEASE_MANIFEST ENV_FILE [PRIVATE_RAG_ACTIVATION_RECEIPT]" >&2
  exit 2
}
manifest_path=${1:?release manifest path is required}
source_env=${2:?deployment environment file is required}
activation_receipt=${3:-}
deploy_root=${EISENHOWER_DEPLOY_ROOT:-$(pwd)}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
state_dir="$deploy_root/.deploy"
marker="$deploy_root/.eisenhower-deployment"

test -f "$marker" || { echo "Deployment ownership marker is missing." >&2; exit 1; }
test -s "$manifest_path"
test -s "$source_env"
if [ -n "$activation_receipt" ]; then
  "$script_dir/verify-private-rag.sh" "$activation_receipt" "$manifest_path" "$source_env"
fi
mkdir -p "$state_dir"
chmod 0700 "$state_dir"

generated_env=$(mktemp "$state_dir/release-env.XXXXXX")
trap 'rm -f "$generated_env"' EXIT
chmod 0600 "$generated_env"

require_digest() {
  local manifest=$1 output=$2 name=$3 variable=$4 digest
  digest=$(jq -er --arg name "$name" '.images[] | select(.name == $name) | .digest | select(test("@sha256:[0-9a-f]{64}$"))' "$manifest")
  printf '%s=%s\n' "$variable" "$digest" >> "$output"
}

build_release_env() {
  local manifest=$1 output=$2 sha
  sha=$(jq -er '.release_sha | select(test("^[0-9a-f]{40}$"))' "$manifest")
  cp "$source_env" "$output"
  printf 'APP_ENV=production\nAUTH_MODE=oidc\nRELEASE_SHA=%s\n' "$sha" >> "$output"
  require_digest "$manifest" "$output" backend-ai-boundary AI_BOUNDARY_IMAGE
  require_digest "$manifest" "$output" backend-ai-classifier AI_CLASSIFIER_IMAGE
  require_digest "$manifest" "$output" backend-ai-knowledge AI_KNOWLEDGE_IMAGE
  require_digest "$manifest" "$output" backend-ai-ingest AI_INGEST_IMAGE
  require_digest "$manifest" "$output" backend-ai-response-rocm AMD_RESPONSE_IMAGE
  require_digest "$manifest" "$output" backend-node API_IMAGE
  require_digest "$manifest" "$output" mcp MCP_IMAGE
  require_digest "$manifest" "$output" web WEB_IMAGE
}

release_sha=$(jq -er '.release_sha | select(test("^[0-9a-f]{40}$"))' "$manifest_path")
build_release_env "$manifest_path" "$generated_env"

compose=(docker compose --project-directory "$deploy_root" --env-file "$generated_env" -f "$deploy_root/compose.yaml")
if [ -n "$activation_receipt" ]; then
  compose+=(-f "$deploy_root/deploy/inference/compose.amd.yaml" --profile inference-amd)
fi
"${compose[@]}" config --quiet
"${compose[@]}" pull

previous_manifest="$state_dir/active-release-manifest.json"
rollback_manifest="$state_dir/rollback-release-manifest.json"
if [ -s "$previous_manifest" ]; then cp "$previous_manifest" "$rollback_manifest"; fi

rollback() {
  if [ -s "$rollback_manifest" ]; then
    echo "Deployment failed; restoring the previous immutable manifest." >&2
    rollback_env=$(mktemp "$state_dir/rollback-env.XXXXXX")
    chmod 0600 "$rollback_env"
    build_release_env "$rollback_manifest" "$rollback_env"
    set +e
    docker compose --project-directory "$deploy_root" --env-file "$rollback_env" \
      -f "$deploy_root/compose.yaml" pull
    docker compose --project-directory "$deploy_root" --env-file "$rollback_env" \
      -f "$deploy_root/compose.yaml" up -d --remove-orphans --wait
    rollback_status=$?
    rm -f "$rollback_env"
    set -e
    return "$rollback_status"
  fi
}
trap rollback ERR
trap 'rm -f "$generated_env"' EXIT
"${compose[@]}" up -d --remove-orphans --wait

for service in web api-service ai-service classifier-service knowledge-service rag-worker mcp-service; do
  container_id=$("${compose[@]}" ps -q "$service")
  test -n "$container_id"
  test "$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container_id")" = "$release_sha"
done
if [ -n "$activation_receipt" ]; then
  for service in inference reranker; do
    container_id=$("${compose[@]}" ps -q "$service")
    test -n "$container_id"
    test "$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container_id")" = "$release_sha"
  done
fi

cp "$manifest_path" "$state_dir/active-release-manifest.json"
chmod 0600 "$state_dir/active-release-manifest.json"
rm -f "$rollback_manifest"
trap - ERR EXIT
rm -f "$generated_env"
