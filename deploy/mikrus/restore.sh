#!/usr/bin/env bash
set -euo pipefail

: "${MIKRUS_APP_DIR:?MIKRUS_APP_DIR is required}"
: "${EISENHOWER_BACKUP_SET:?EISENHOWER_BACKUP_SET is required}"
: "${DOCKER_HUB_USERNAME:?DOCKER_HUB_USERNAME is required}"

if [[ "${RESTORE_CONFIRM:-}" != "restore-eisenhower-data" ]]; then
  echo "Refusing destructive restore. Set RESTORE_CONFIRM=restore-eisenhower-data explicitly." >&2
  exit 1
fi
if [[ "$MIKRUS_APP_DIR" != /* || "$MIKRUS_APP_DIR" == "/" || "$EISENHOWER_BACKUP_SET" != /* ]]; then
  echo "Deployment and backup-set paths must be absolute and deployment must not be root." >&2
  exit 1
fi
if [[ "$(tr -d '\r\n' < "$MIKRUS_APP_DIR/.eisenhower-deployment" 2>/dev/null || true)" != "eisenhower" ]]; then
  echo "Invalid deployment ownership marker." >&2
  exit 1
fi

for file in SHA256SUMS mongodb.archive.gz ai-data.tar.gz image-tag; do
  if [[ ! -f "$EISENHOWER_BACKUP_SET/$file" || -L "$EISENHOWER_BACKUP_SET/$file" ]]; then
    echo "Missing or unsafe backup file: $file" >&2
    exit 1
  fi
done

(
  cd "$EISENHOWER_BACKUP_SET"
  sha256sum --check SHA256SUMS
)

if tar -tzf "$EISENHOWER_BACKUP_SET/ai-data.tar.gz" | awk '/^\// || /(^|\/)\.\.($|\/)/ { found=1 } END { exit !found }'; then
  echo "AI data archive contains an unsafe path." >&2
  exit 1
fi

cd "$MIKRUS_APP_DIR"
export IMAGE_TAG="$(tr -d '\r\n' < .deployed-image-tag)"

restart_services() {
  docker compose --env-file .env -f docker-compose.yml up -d >/dev/null || true
}
trap restart_services EXIT

docker compose --env-file .env -f docker-compose.yml stop frontend api-service ai-service
docker compose --env-file .env -f docker-compose.yml exec -T mongodb \
  mongorestore --drop --archive --gzip < "$EISENHOWER_BACKUP_SET/mongodb.archive.gz"
docker compose --env-file .env -f docker-compose.yml run --rm --no-deps -T ai-service \
  sh -c 'find /app/data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -C /app/data -xzf -' \
  < "$EISENHOWER_BACKUP_SET/ai-data.tar.gz"

docker compose --env-file .env -f docker-compose.yml up -d
trap - EXIT
echo "Restore completed from $EISENHOWER_BACKUP_SET. Run the public acceptance smoke now."
