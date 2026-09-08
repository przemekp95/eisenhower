#!/usr/bin/env bash
set -euo pipefail

test "$#" -eq 3 || {
  echo "Usage: verify-private-rag.sh ACTIVATION_RECEIPT RELEASE_MANIFEST ENV_FILE" >&2
  exit 2
}
receipt=${1:?activation receipt is required}
manifest=${2:?release manifest is required}
env_file=${3:?environment file is required}
deploy_root=${EISENHOWER_DEPLOY_ROOT:-$(pwd)}

test -s "$receipt"
test -s "$manifest"
test -s "$env_file"
test "$(stat -c '%a' "$receipt")" = 600 || {
  echo "activation receipt permissions must be 0600" >&2
  exit 1
}

release_sha=$(jq -er '.release_sha | select(test("^[0-9a-f]{40}$"))' "$manifest")
receipt_sha=$(jq -er '.source_git_sha | select(test("^[0-9a-f]{40}$"))' "$receipt")
test "$receipt_sha" = "$release_sha" || {
  echo "activation receipt release SHA mismatch" >&2
  exit 1
}
jq -e '.schema_version == "private-rag-activation-v1"' "$receipt" >/dev/null

response_digest=$(jq -er '.images[] | select(.name == "backend-ai-response-rocm") | .digest' "$manifest")
test "$(jq -er '.models.generator.image_digest' "$receipt")" = "$response_digest"
test "$(jq -er '.models.reranker.image_digest' "$receipt")" = "$response_digest"

manifest_path="$deploy_root/docs/ai-rebuild/corpus-manifest-v1.json"
test -s "$manifest_path"
test "$(sha256sum "$manifest_path" | awk '{print $1}')" = "$(jq -er '.corpus_manifest_sha256' "$receipt")"
jq -e '
  .tenant_id == "eisenhower-owner"
  and .project_ids == ["eisenhower"]
  and (.response_users | length == 1)
  and (.response_users[0] | test("^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"))
  and .memory == {"write":false,"retrieval":false,"response":false}
  and .mag_mode == "disabled"
  and .public_release_authorized == false
  and (.canonical_document_count > 0)
  and (.projection_point_count > 0)
' "$receipt" >/dev/null

env_value() {
  local key=$1 count value
  count=$(awk -F= -v key="$key" '$1 == key { count += 1 } END { print count + 0 }' "$env_file")
  test "$count" -eq 1 || {
    echo "environment must define $key exactly once" >&2
    return 1
  }
  value=$(awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$env_file")
  printf '%s' "$value"
}

test "$(env_value RAG_GENERATION_ENABLED)" = true
test "$(env_value RAG_RESPONSE_ENABLED)" = true
test "$(env_value MEMORY_WRITE_ENABLED)" = false
test "$(env_value MEMORY_RETRIEVAL_ENABLED)" = false
test "$(env_value MEMORY_RESPONSE_ENABLED)" = false
test "$(env_value RAG_ALLOWED_TENANTS)" = eisenhower-owner
test "$(env_value RAG_RESPONSE_ALLOWED_USERS)" = "$(jq -er '.response_users[0]' "$receipt")"
test "$(env_value LLAMAINDEX_CANDIDATE_COLLECTION)" = "$(jq -er '.collection' "$receipt")"
test "$(env_value INFERENCE_MODEL)" = "$(jq -er '.models.generator.name' "$receipt")"
test "$(env_value INFERENCE_MODEL_REVISION)" = "$(jq -er '.models.generator.revision' "$receipt")"
test -n "$(env_value INFERENCE_MODEL_CACHE_VOLUME)"
test -n "$(env_value RERANKER_MODEL_CACHE_VOLUME)"

printf '%s\n' "private RAG activation preflight passed"
