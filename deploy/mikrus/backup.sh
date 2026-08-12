#!/usr/bin/env bash
set -euo pipefail

: "${MIKRUS_APP_DIR:?MIKRUS_APP_DIR is required}"
: "${EISENHOWER_BACKUP_DIR:?EISENHOWER_BACKUP_DIR is required}"

if [[ "$MIKRUS_APP_DIR" != /* || "$MIKRUS_APP_DIR" == "/" ]]; then
  echo "MIKRUS_APP_DIR must be a non-root absolute path." >&2
  exit 1
fi
if [[ "$EISENHOWER_BACKUP_DIR" != /* || "$EISENHOWER_BACKUP_DIR" == "/" ]]; then
  echo "EISENHOWER_BACKUP_DIR must be a non-root absolute path." >&2
  exit 1
fi
if [[ "$(tr -d '\r\n' < "$MIKRUS_APP_DIR/.eisenhower-deployment" 2>/dev/null || true)" != "eisenhower" ]]; then
  echo "Invalid deployment ownership marker." >&2
  exit 1
fi

cd "$MIKRUS_APP_DIR"
export IMAGE_TAG="$(tr -d '\r\n' < .deployed-image-tag)"
export DOCKER_HUB_USERNAME="${DOCKER_HUB_USERNAME:?DOCKER_HUB_USERNAME is required}"

backup_id="$(date -u +'%Y%m%dT%H%M%SZ')-${IMAGE_TAG:0:12}"
backup_set="$EISENHOWER_BACKUP_DIR/$backup_id"
mkdir -p "$backup_set"
chmod 700 "$EISENHOWER_BACKUP_DIR" "$backup_set"

mongo_tmp="$backup_set/mongodb.archive.gz.tmp"
ai_tmp="$backup_set/ai-data.tar.gz.tmp"
trap 'rm -f "$mongo_tmp" "$ai_tmp"' EXIT

docker compose --env-file .env -f docker-compose.yml exec -T mongodb \
  mongodump --archive --gzip > "$mongo_tmp"
docker compose --env-file .env -f docker-compose.yml exec -T ai-service \
  tar -C /app/data -czf - . > "$ai_tmp"

mv "$mongo_tmp" "$backup_set/mongodb.archive.gz"
mv "$ai_tmp" "$backup_set/ai-data.tar.gz"
printf '%s\n' "$IMAGE_TAG" > "$backup_set/image-tag"

(
  cd "$backup_set"
  sha256sum mongodb.archive.gz ai-data.tar.gz image-tag > SHA256SUMS
  sha256sum --check SHA256SUMS
)

trap - EXIT
echo "Verified backup created at $backup_set"
