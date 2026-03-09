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

if [ -n "$DOCKER_HUB_TOKEN" ]; then
  printf '%s' "$DOCKER_HUB_TOKEN" | docker login --username "$DOCKER_HUB_USERNAME" --password-stdin
fi

export DOCKER_HUB_USERNAME
docker compose --env-file .env -f docker-compose.yml pull
docker compose --env-file .env -f docker-compose.yml up -d --remove-orphans
docker compose --env-file .env -f docker-compose.yml ps
REMOTE_SCRIPT
