#!/usr/bin/env bash
set -euo pipefail

manifest_path=${1:?release manifest path is required}
source_env=${2:?deployment environment file is required}
enable_n8n=${3:-false}
deploy_root=${EISENHOWER_DEPLOY_ROOT:-$(pwd)}
state_dir="$deploy_root/.deploy"
marker="$deploy_root/.eisenhower-deployment"

test -f "$marker" || { echo "Deployment ownership marker is missing." >&2; exit 1; }
test -s "$manifest_path"
test -s "$source_env"
test "$enable_n8n" = false || test "$enable_n8n" = true
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
  require_digest "$manifest" "$output" backend-node API_IMAGE
  require_digest "$manifest" "$output" mcp MCP_IMAGE
  require_digest "$manifest" "$output" web WEB_IMAGE
}

release_sha=$(jq -er '.release_sha | select(test("^[0-9a-f]{40}$"))' "$manifest_path")
build_release_env "$manifest_path" "$generated_env"

compose=(docker compose --project-directory "$deploy_root" --env-file "$generated_env" -f "$deploy_root/compose.yaml")
profiles=()
if [ "$enable_n8n" = true ]; then profiles=(--profile n8n); fi
"${compose[@]}" "${profiles[@]}" config --quiet
"${compose[@]}" "${profiles[@]}" pull

previous_manifest="$state_dir/active-release-manifest.json"
rollback_manifest="$state_dir/rollback-release-manifest.json"
active_n8n_profile="$state_dir/active-n8n-profile"
rollback_n8n_profile="$state_dir/rollback-n8n-profile"
if [ -s "$previous_manifest" ]; then cp "$previous_manifest" "$rollback_manifest"; fi
if [ -s "$active_n8n_profile" ]; then
  previous_n8n=$(cat "$active_n8n_profile")
  test "$previous_n8n" = false || test "$previous_n8n" = true
  printf '%s\n' "$previous_n8n" > "$rollback_n8n_profile"
fi

rollback() {
  if [ -s "$rollback_manifest" ]; then
    echo "Deployment failed; restoring the previous immutable manifest." >&2
    rollback_env=$(mktemp "$state_dir/rollback-env.XXXXXX")
    chmod 0600 "$rollback_env"
    build_release_env "$rollback_manifest" "$rollback_env"
    rollback_profiles=()
    if [ -s "$rollback_n8n_profile" ] && [ "$(cat "$rollback_n8n_profile")" = true ]; then
      rollback_profiles=(--profile n8n)
    fi
    set +e
    docker compose --project-directory "$deploy_root" --env-file "$rollback_env" \
      -f "$deploy_root/compose.yaml" "${rollback_profiles[@]}" pull
    docker compose --project-directory "$deploy_root" --env-file "$rollback_env" \
      -f "$deploy_root/compose.yaml" "${rollback_profiles[@]}" up -d --remove-orphans --wait
    rollback_status=$?
    rm -f "$rollback_env"
    set -e
    return "$rollback_status"
  fi
}
trap rollback ERR
trap 'rm -f "$generated_env"' EXIT
"${compose[@]}" "${profiles[@]}" up -d --remove-orphans --wait

for service in web api-service ai-service classifier-service knowledge-service rag-worker mcp-service; do
  container_id=$("${compose[@]}" ps -q "$service")
  test -n "$container_id"
  test "$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container_id")" = "$release_sha"
done

cp "$manifest_path" "$state_dir/active-release-manifest.json"
chmod 0600 "$state_dir/active-release-manifest.json"
printf '%s\n' "$enable_n8n" > "$active_n8n_profile"
chmod 0600 "$active_n8n_profile"
rm -f "$rollback_manifest" "$rollback_n8n_profile"
trap - ERR EXIT
rm -f "$generated_env"
