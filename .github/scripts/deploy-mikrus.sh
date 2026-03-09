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
  DOCKER_HUB_USERNAME
)

for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    error "$var_name is required."
    exit 1
  fi
done

default_app_dir="/home/${MIKRUS_USER}/apps/demo-fortis"
if [[ "${MIKRUS_USER}" == "root" ]]; then
  default_app_dir="/root/apps/demo-fortis"
fi
app_dir="${MIKRUS_APP_DIR:-$default_app_dir}"

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

log "Deploy target: ${ssh_target}:${app_dir}"

log "Testing SSH connectivity."
if ! ssh "${ssh_opts[@]}" "$ssh_target" "echo ssh-ok" >/dev/null; then
  error "SSH connectivity test failed for ${ssh_target}. Check host reachability and key validity."
  exit 1
fi

log "Preparing application directory on target host."
ssh "${ssh_opts[@]}" "$ssh_target" "mkdir -p '$app_dir'"

log "Uploading docker-compose.yml."
scp "${ssh_opts[@]}" "deploy/mikrus/docker-compose.yml" "$scp_target"

log "Uploading .env file."
printf '%s' "$MIKRUS_ENV_FILE" | ssh "${ssh_opts[@]}" "$ssh_target" "cat > '$app_dir/.env' && chmod 600 '$app_dir/.env'"

app_dir_q=$(printf '%q' "$app_dir")
docker_hub_username_q=$(printf '%q' "$DOCKER_HUB_USERNAME")
docker_hub_token_q=$(printf '%q' "${DOCKER_HUB_TOKEN:-}")

log "Running remote docker compose update."
ssh "${ssh_opts[@]}" "$ssh_target" \
  "APP_DIR=$app_dir_q DOCKER_HUB_USERNAME=$docker_hub_username_q DOCKER_HUB_TOKEN=$docker_hub_token_q bash -s" <<'REMOTE_SCRIPT'
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

web_port="$(read_env_value WEB_PORT 8080)"
api_port="$(read_env_value API_PORT 3001)"
ai_port="$(read_env_value AI_PORT 8000)"

echo "Preflight host ports: frontend=$web_port api=$api_port ai=$ai_port"
check_host_port "frontend" "WEB_PORT" "$web_port"
check_host_port "api-service" "API_PORT" "$api_port"
check_host_port "ai-service" "AI_PORT" "$ai_port"

if [ -n "$DOCKER_HUB_TOKEN" ]; then
  printf '%s' "$DOCKER_HUB_TOKEN" | docker login --username "$DOCKER_HUB_USERNAME" --password-stdin
fi

export DOCKER_HUB_USERNAME
docker compose --env-file .env -f docker-compose.yml pull
docker compose --env-file .env -f docker-compose.yml up -d --remove-orphans
docker compose --env-file .env -f docker-compose.yml ps
REMOTE_SCRIPT
