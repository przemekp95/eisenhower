#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[deploy-mikrus] $*"
}

warn() {
  echo "::warning::$*"
}

error() {
  echo "::error::$*"
}

required_vars=(
  MIKRUS_HOST
  MIKRUS_USER
  MIKRUS_SSH_KEY
  MIKRUS_ENV_FILE
  MIKRUS_APP_DIR
  MIKRUS_PUBLIC_URL
  DOCKER_HUB_USERNAME
  IMAGE_TAG
)

for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    error "$var_name is required."
    exit 1
  fi
done

app_dir="$MIKRUS_APP_DIR"

if [[ "$app_dir" != /* || "$app_dir" == "/" || ! "$app_dir" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  error "MIKRUS_APP_DIR must be a safe absolute path and must not be root."
  exit 1
fi

if [[ ! "$MIKRUS_PUBLIC_URL" =~ ^https://[^/[:space:]]+(/.*)?$ ]]; then
  error "MIKRUS_PUBLIC_URL must be a public HTTPS URL."
  exit 1
fi

if [[ ! "$IMAGE_TAG" =~ ^[0-9a-f]{40}$ ]]; then
  error "IMAGE_TAG must be a full Git commit SHA."
  exit 1
fi

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

key_path="$HOME/.ssh/mikrus_deploy_key"
known_hosts_path="$HOME/.ssh/known_hosts"
trap 'rm -f "$key_path"' EXIT

printf '%s\n' "$MIKRUS_SSH_KEY" > "$key_path"
chmod 600 "$key_path"
touch "$known_hosts_path"
chmod 600 "$known_hosts_path"

strict_host_checking="yes"
keyscan_tmp_err="$(mktemp)"

if ssh-keyscan -6 -T 15 -H "$MIKRUS_HOST" >> "$known_hosts_path" 2>"$keyscan_tmp_err"; then
  log "Collected host key via IPv6 ssh-keyscan."
elif ssh-keyscan -T 15 -H "$MIKRUS_HOST" >> "$known_hosts_path" 2>"$keyscan_tmp_err"; then
  warn "IPv6 host key scan failed; using default family ssh-keyscan."
else
  warn "Host key scan failed for '$MIKRUS_HOST': $(tr '\n' ' ' < "$keyscan_tmp_err")"
  warn "Falling back to StrictHostKeyChecking=accept-new."
  strict_host_checking="accept-new"
fi
rm -f "$keyscan_tmp_err"

ssh_opts=(
  -i "$key_path"
  -o BatchMode=yes
  -o StrictHostKeyChecking="$strict_host_checking"
  -o UserKnownHostsFile="$known_hosts_path"
  -o ConnectTimeout=15
)

ssh_target="${MIKRUS_USER}@${MIKRUS_HOST}"
scp_host="$MIKRUS_HOST"
if [[ "$MIKRUS_HOST" == *:* ]]; then
  scp_host="[${MIKRUS_HOST}]"
fi
scp_target="${MIKRUS_USER}@${scp_host}:${app_dir}/docker-compose.yml"
http_check_scp_target="${MIKRUS_USER}@${scp_host}:${app_dir}/assert-http-status.sh"
prometheus_scp_target="${MIKRUS_USER}@${scp_host}:${app_dir}/prometheus.yml"
alerts_scp_target="${MIKRUS_USER}@${scp_host}:${app_dir}/alert_rules.yml"

log "Deploy target: ${ssh_target}:${app_dir}"

log "Testing SSH connectivity."
if ! ssh "${ssh_opts[@]}" "$ssh_target" "echo ssh-ok" >/dev/null; then
  error "SSH connectivity test failed for ${ssh_target}. Check host reachability and key validity."
  exit 1
fi

log "Verifying deployment directory ownership."
ssh "${ssh_opts[@]}" "$ssh_target" bash -s -- "$app_dir" <<'REMOTE_OWNERSHIP_CHECK'
set -euo pipefail
app_dir="$1"
marker="$app_dir/.eisenhower-deployment"

if [[ -d "$app_dir" && ! -f "$marker" ]] && find "$app_dir" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  echo "Refusing to deploy into a non-empty directory without $marker." >&2
  exit 1
fi

mkdir -p "$app_dir"
if [[ -f "$marker" ]] && [[ "$(tr -d '\r\n' < "$marker")" != "eisenhower" ]]; then
  echo "Deployment ownership marker does not belong to eisenhower." >&2
  exit 1
fi
printf 'eisenhower\n' > "$marker"
REMOTE_OWNERSHIP_CHECK

log "Saving the currently deployed configuration for rollback."
ssh "${ssh_opts[@]}" "$ssh_target" bash -s -- "$app_dir" <<'REMOTE_BACKUP'
set -euo pipefail
app_dir="$1"
rm -f \
  "$app_dir/docker-compose.rollback.yml" \
  "$app_dir/.env.rollback" \
  "$app_dir/.rollback-image-tag"
if [[ -f "$app_dir/docker-compose.yml" ]]; then
  cp "$app_dir/docker-compose.yml" "$app_dir/docker-compose.rollback.yml"
fi
if [[ -f "$app_dir/.env" ]]; then
  cp "$app_dir/.env" "$app_dir/.env.rollback"
  chmod 600 "$app_dir/.env.rollback"
fi
if [[ -f "$app_dir/.deployed-image-tag" ]]; then
  cp "$app_dir/.deployed-image-tag" "$app_dir/.rollback-image-tag"
fi
REMOTE_BACKUP

log "Uploading docker-compose.yml."
scp "${ssh_opts[@]}" "deploy/mikrus/docker-compose.yml" "$scp_target"

log "Uploading private Prometheus configuration and alert rules."
scp "${ssh_opts[@]}" "deploy/mikrus/prometheus.yml" "$prometheus_scp_target"
scp "${ssh_opts[@]}" "deploy/mikrus/alert_rules.yml" "$alerts_scp_target"

log "Uploading fail-closed HTTP status verifier."
scp "${ssh_opts[@]}" ".github/scripts/assert-http-status.sh" "$http_check_scp_target"
ssh "${ssh_opts[@]}" "$ssh_target" "chmod 700 '$app_dir/assert-http-status.sh'"

log "Uploading .env file."
printf '%s' "$MIKRUS_ENV_FILE" | ssh "${ssh_opts[@]}" "$ssh_target" "cat > '$app_dir/.env' && chmod 600 '$app_dir/.env'"

app_dir_q=$(printf '%q' "$app_dir")
docker_hub_username_q=$(printf '%q' "$DOCKER_HUB_USERNAME")
docker_hub_token_q=$(printf '%q' "${DOCKER_HUB_TOKEN:-}")
image_tag_q=$(printf '%q' "$IMAGE_TAG")
public_url_q=$(printf '%q' "${MIKRUS_PUBLIC_URL%/}")

log "Running remote docker compose update."
ssh "${ssh_opts[@]}" "$ssh_target" \
  "APP_DIR=$app_dir_q DOCKER_HUB_USERNAME=$docker_hub_username_q DOCKER_HUB_TOKEN=$docker_hub_token_q IMAGE_TAG=$image_tag_q MIKRUS_PUBLIC_URL=$public_url_q bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required on the target host."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is required on the target host."
  exit 1
fi

cd "$APP_DIR"

compose_project="eisenhower"
previous_tag=""
if [[ -f .rollback-image-tag ]]; then
  previous_tag="$(tr -d '\r\n' < .rollback-image-tag)"
fi

rollback_deployment() {
  echo "Deployment failed; attempting rollback."
  if [[ -z "$previous_tag" || ! -f docker-compose.rollback.yml || ! -f .env.rollback ]]; then
    echo "No verified previous version is available for automatic rollback." >&2
    return 1
  fi

  cp docker-compose.rollback.yml docker-compose.yml
  cp .env.rollback .env
  chmod 600 .env
  export IMAGE_TAG="$previous_tag"
  docker compose --env-file .env -f docker-compose.yml up -d --remove-orphans
  printf '%s\n' "$previous_tag" > .deployed-image-tag
  echo "Rolled back to image tag $previous_tag."
}

trap 'status=$?; trap - ERR; rollback_deployment || true; exit "$status"' ERR

read_env_value() {
  local name="$1"
  local default_value="$2"
  local value

  value="$(grep -E "^${name}=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r')"
  if [[ -n "$value" ]]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$default_value"
  fi
}

check_host_port() {
  local service_name="$1"
  local env_name="$2"
  local port="$3"
  local docker_publishers
  local foreign_publishers
  local listeners
  local foreign_listeners

  docker_publishers="$(docker ps --format '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Ports}}' --filter "publish=$port" || true)"
  foreign_publishers="$(printf '%s\n' "$docker_publishers" | awk -F '\t' -v project="$compose_project" 'NF && $3 != project { print }')"

  if [[ -n "$foreign_publishers" ]]; then
    echo "Host port $port required by $service_name is already published by another container:"
    echo "$foreign_publishers"
    echo "Set ${env_name} to a free host port in ${APP_DIR}/.env (from the MIKRUS_ENV_FILE GitHub secret) and redeploy."
    exit 1
  fi

  if command -v ss >/dev/null 2>&1; then
    listeners="$(ss -ltnp "( sport = :$port )" 2>/dev/null | tail -n +2 || true)"
    foreign_listeners="$(printf '%s\n' "$listeners" | grep -v 'docker-proxy' || true)"

    if [[ -n "$foreign_listeners" ]]; then
      echo "Host port $port required by $service_name is already in use:"
      echo "$foreign_listeners"
      echo "Set ${env_name} to a free host port in ${APP_DIR}/.env (from the MIKRUS_ENV_FILE GitHub secret) and redeploy."
      exit 1
    fi
  fi
}

if [[ ! -f .eisenhower-deployment ]] || [[ "$(tr -d '\r\n' < .eisenhower-deployment)" != "eisenhower" ]]; then
  echo "Invalid or missing .eisenhower-deployment ownership marker."
  exit 1
fi

web_port="$(read_env_value WEB_PORT 8080)"

echo "Preflight host port: frontend=$web_port"
check_host_port "frontend" "WEB_PORT" "$web_port"

if [ -n "$DOCKER_HUB_TOKEN" ]; then
  printf '%s' "$DOCKER_HUB_TOKEN" | docker login --username "$DOCKER_HUB_USERNAME" --password-stdin
fi

export DOCKER_HUB_USERNAME
export IMAGE_TAG
docker compose --env-file .env -f docker-compose.yml pull
docker compose --env-file .env -f docker-compose.yml up -d --remove-orphans
docker compose --env-file .env -f docker-compose.yml ps

echo "Waiting for container readiness."
deadline=$((SECONDS + 180))
while (( SECONDS < deadline )); do
  ready=true
  for service in mongodb ai-service api-service frontend prometheus; do
    container_id="$(docker compose --env-file .env -f docker-compose.yml ps -q "$service")"
    if [[ -z "$container_id" ]]; then
      ready=false
      break
    fi
    state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
    if [[ "$state" != "running" || ( "$health" != "none" && "$health" != "healthy" ) ]]; then
      ready=false
      break
    fi
  done
  if [[ "$ready" == "true" ]]; then
    break
  fi
  sleep 5
done

if [[ "$ready" != "true" ]]; then
  docker compose --env-file .env -f docker-compose.yml ps
  docker compose --env-file .env -f docker-compose.yml logs --tail=100
  echo "Containers did not become ready within 180 seconds." >&2
  false
fi

echo "Running public HTTPS smoke checks."
./assert-http-status.sh "$MIKRUS_PUBLIC_URL/health" 200
./assert-http-status.sh "$MIKRUS_PUBLIC_URL/api/health" 200
./assert-http-status.sh "$MIKRUS_PUBLIC_URL/ai/" 200
./assert-http-status.sh "$MIKRUS_PUBLIC_URL/ai/health/live" 200
./assert-http-status.sh "$MIKRUS_PUBLIC_URL/ai/health/ready" 200

echo "Verifying exact-SHA process metrics and active Prometheus rules."
expected_release_metric="eisenhower_release_info{sha=\"$IMAGE_TAG\"} 1"
docker compose --env-file .env -f docker-compose.yml exec -T ai-service \
  curl -fsS http://127.0.0.1:8000/metrics | grep -F "$expected_release_metric"
docker compose --env-file .env -f docker-compose.yml exec -T prometheus \
  wget -qO- http://127.0.0.1:9090/api/v1/rules | grep -F 'EisenhowerAuditWriteFailed'

printf '%s\n' "$IMAGE_TAG" > .deployed-image-tag
rm -f docker-compose.rollback.yml .env.rollback .rollback-image-tag
trap - ERR
echo "Deployment $IMAGE_TAG passed readiness and public smoke checks."
REMOTE_SCRIPT
