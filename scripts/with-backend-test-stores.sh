#!/bin/sh
set -eu

postgres_name=
redis_name=

cleanup() {
  if [ -n "$redis_name" ]; then
    docker rm --force "$redis_name" >/dev/null 2>&1 || true
  fi
  if [ -n "$postgres_name" ]; then
    docker rm --force "$postgres_name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

if [ -z "${POSTGRES_TEST_URL:-}" ] || [ -z "${REDIS_TEST_URL:-}" ]; then
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    echo "Docker is required when POSTGRES_TEST_URL or REDIS_TEST_URL is not supplied." >&2
    exit 1
  fi
fi

if [ -z "${POSTGRES_TEST_URL:-}" ]; then
  postgres_name="eisenhower-verify-postgres-$$"
  docker run --detach --name "$postgres_name" \
    --env POSTGRES_USER=eisenhower \
    --env POSTGRES_PASSWORD=eisenhower_test \
    --env POSTGRES_DB=eisenhower \
    --publish 127.0.0.1::5432 \
    postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777 \
    >/dev/null
  postgres_port=$(docker port "$postgres_name" 5432/tcp | awk -F: 'NR == 1 { print $NF }')
  POSTGRES_TEST_URL="postgresql://eisenhower:eisenhower_test@127.0.0.1:${postgres_port}/eisenhower"
  export POSTGRES_TEST_URL

  postgres_ready=false
  for _ in $(seq 1 30); do
    if docker exec "$postgres_name" pg_isready -U eisenhower -d eisenhower >/dev/null 2>&1; then
      postgres_ready=true
      break
    fi
    sleep 1
  done
  if [ "$postgres_ready" != true ]; then
    docker logs "$postgres_name" >&2
    exit 1
  fi

  (
    cd backend-node
    DATABASE_URL="$POSTGRES_TEST_URL" npx prisma migrate deploy
  )
fi

if [ -z "${REDIS_TEST_URL:-}" ]; then
  redis_name="eisenhower-verify-redis-$$"
  docker run --detach --name "$redis_name" \
    --publish 127.0.0.1::6379 \
    redis:7-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2 \
    >/dev/null
  redis_port=$(docker port "$redis_name" 6379/tcp | awk -F: 'NR == 1 { print $NF }')
  REDIS_TEST_URL="redis://127.0.0.1:${redis_port}"
  export REDIS_TEST_URL

  redis_ready=false
  for _ in $(seq 1 30); do
    if docker exec "$redis_name" redis-cli ping 2>/dev/null | grep -qx PONG; then
      redis_ready=true
      break
    fi
    sleep 1
  done
  if [ "$redis_ready" != true ]; then
    docker logs "$redis_name" >&2
    exit 1
  fi
fi

"$@"
