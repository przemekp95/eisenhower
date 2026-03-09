#!/usr/bin/env bash
set -euo pipefail

required_vars=(
  MIKRUS_HOST
  MIKRUS_USER
  MIKRUS_SSH_KEY
  MIKRUS_ENV_FILE
  DOCKER_HUB_USERNAME
)

for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    echo "::error::$var_name is required."
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

if ! ssh-keyscan -6 -H "$MIKRUS_HOST" >> "$known_hosts_path" 2>/dev/null; then
  ssh-keyscan -H "$MIKRUS_HOST" >> "$known_hosts_path" 2>/dev/null
fi

ssh_opts=(
  -i "$key_path"
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$known_hosts_path"
  -o ConnectTimeout=15
)

ssh_target="${MIKRUS_USER}@${MIKRUS_HOST}"
scp_host="$MIKRUS_HOST"
if [[ "$MIKRUS_HOST" == *:* ]]; then
  scp_host="[${MIKRUS_HOST}]"
fi
scp_target="${MIKRUS_USER}@${scp_host}:${app_dir}/docker-compose.yml"

echo "Deploy target: ${ssh_target}:${app_dir}"

ssh "${ssh_opts[@]}" "$ssh_target" "mkdir -p '$app_dir'"
scp "${ssh_opts[@]}" "deploy/mikrus/docker-compose.yml" "$scp_target"
printf '%s' "$MIKRUS_ENV_FILE" | ssh "${ssh_opts[@]}" "$ssh_target" "cat > '$app_dir/.env' && chmod 600 '$app_dir/.env'"

app_dir_q=$(printf '%q' "$app_dir")
docker_hub_username_q=$(printf '%q' "$DOCKER_HUB_USERNAME")
docker_hub_token_q=$(printf '%q' "${DOCKER_HUB_TOKEN:-}")

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

if [ -n "$DOCKER_HUB_TOKEN" ]; then
  printf '%s' "$DOCKER_HUB_TOKEN" | docker login --username "$DOCKER_HUB_USERNAME" --password-stdin
fi

export DOCKER_HUB_USERNAME
docker compose --env-file .env -f docker-compose.yml pull
docker compose --env-file .env -f docker-compose.yml up -d --remove-orphans
docker compose --env-file .env -f docker-compose.yml ps
REMOTE_SCRIPT
