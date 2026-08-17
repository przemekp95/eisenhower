#!/usr/bin/env bash
set -euo pipefail

deploy_root=${EISENHOWER_DEPLOY_ROOT:-$(pwd)}
env_file=${DEPLOY_ENV_FILE:?DEPLOY_ENV_FILE is required}
backup_root=${EISENHOWER_BACKUP_DIR:?EISENHOWER_BACKUP_DIR is required}
marker="$deploy_root/.eisenhower-deployment"
active_manifest="$deploy_root/.deploy/active-release-manifest.json"

test "$deploy_root" != / && test "$backup_root" != /
test "$(tr -d '\r\n' < "$marker" 2>/dev/null || true)" = eisenhower
test -s "$active_manifest"
backup_id="$(date -u +'%Y%m%dT%H%M%SZ')-$(jq -r .release_sha "$active_manifest" | cut -c1-12)"
backup_set="$backup_root/$backup_id"
mkdir -p "$backup_set"
chmod 0700 "$backup_root" "$backup_set"

compose=(docker compose --project-directory "$deploy_root" --env-file "$env_file" -f "$deploy_root/compose.yaml")
restart() {
  rm -f "$backup_set"/*.tmp
  "${compose[@]}" up -d --wait >/dev/null || true
}
trap restart EXIT
"${compose[@]}" stop gateway oauth2-proxy n8n grafana mcp-service api-service ai-service classifier-service knowledge-service rag-worker identity-service identity-db
"${compose[@]}" exec -T mongodb mongodump --archive --gzip > "$backup_set/mongodb.archive.gz.tmp"
"${compose[@]}" --profile maintenance run --rm --no-deps -T backup-volume-helper \
  sh -c 'tar -C /volumes -czf - audit n8n grafana identity rag-jobs' > "$backup_set/private-volumes.tar.gz.tmp"
cp "$active_manifest" "$backup_set/release-manifest.json.tmp"
mv "$backup_set/mongodb.archive.gz.tmp" "$backup_set/mongodb.archive.gz"
mv "$backup_set/private-volumes.tar.gz.tmp" "$backup_set/private-volumes.tar.gz"
mv "$backup_set/release-manifest.json.tmp" "$backup_set/release-manifest.json"
(cd "$backup_set" && sha256sum mongodb.archive.gz private-volumes.tar.gz release-manifest.json > SHA256SUMS && sha256sum -c SHA256SUMS)
"${compose[@]}" up -d --wait
trap - EXIT
echo "Verified canonical backup created at $backup_set"
