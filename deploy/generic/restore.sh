#!/usr/bin/env bash
set -euo pipefail

deploy_root=${EISENHOWER_DEPLOY_ROOT:-$(pwd)}
env_file=${DEPLOY_ENV_FILE:?DEPLOY_ENV_FILE is required}
backup_set=${EISENHOWER_BACKUP_SET:?EISENHOWER_BACKUP_SET is required}
test "${RESTORE_CONFIRM:-}" = restore-eisenhower-data || { echo "Explicit restore confirmation is required." >&2; exit 1; }
test "$deploy_root" != / && test "$backup_set" != /
test "$(tr -d '\r\n' < "$deploy_root/.eisenhower-deployment" 2>/dev/null || true)" = eisenhower
for file in SHA256SUMS mongodb.archive.gz private-volumes.tar.gz release-manifest.json; do
  test -f "$backup_set/$file" && test ! -L "$backup_set/$file"
done
(cd "$backup_set" && sha256sum -c SHA256SUMS)
if tar -tzf "$backup_set/private-volumes.tar.gz" | awk '/^\// || /(^|\/)\.\.($|\/)/ {bad=1} END {exit !bad}'; then
  echo "Unsafe backup archive path." >&2
  exit 1
fi

compose=(docker compose --project-directory "$deploy_root" --env-file "$env_file" -f "$deploy_root/compose.yaml")
restart() { "${compose[@]}" up -d >/dev/null || true; }
trap restart EXIT
"${compose[@]}" stop web gateway oauth2-proxy n8n grafana prometheus mcp-service api-service ai-service classifier-service knowledge-service rag-worker identity-service
"${compose[@]}" exec -T mongodb mongorestore --drop --archive --gzip < "$backup_set/mongodb.archive.gz"
"${compose[@]}" --profile maintenance run --rm --no-deps -T backup-volume-helper \
  sh -c 'find /volumes/audit /volumes/n8n /volumes/grafana /volumes/identity /volumes/rag-jobs -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -C /volumes -xzf -' \
  < "$backup_set/private-volumes.tar.gz"
"${compose[@]}" up -d --wait
trap - EXIT
echo "Restore completed; run authenticated and Calendar acceptance checks before cutover."
