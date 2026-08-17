#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
runtime_suffix=$$
runtime_network="eisenhower-admin-contract-$runtime_suffix"
identity_container="eisenhower-identity-contract-$runtime_suffix"
keycloak_image=${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.7.0}

cleanup() {
  docker rm -f "$identity_container" >/dev/null 2>&1 || true
  docker network rm "$runtime_network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$runtime_network" >/dev/null
docker run -d --name "$identity_container" \
  --network "$runtime_network" --network-alias identity-service \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=contract-admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=contract-admin-password \
  -e EISENHOWER_OIDC_REDIRECT_URI=https://app.example.test/oauth/callback \
  -e EISENHOWER_OIDC_WEB_ORIGIN=https://app.example.test \
  -e 'EISENHOWER_OIDC_POST_LOGOUT_REDIRECT_URI=https://app.example.test/*' \
  -e EISENHOWER_MCP_REDIRECT_URI=http://127.0.0.1:33418/oauth/callback \
  -e EISENHOWER_MCP_CLIENT_SECRET=contract-mcp-secret \
  -e OIDC_MCP_RESOURCE_URL=https://mcp.example.test/mcp \
  -e ADMIN_OIDC_CLIENT_SECRET=contract-admin-client-secret \
  -e ADMIN_OIDC_REDIRECT_URI=https://admin.example.test/oauth2/callback \
  -v "$repo_root/deploy/local/identity/eisenhower-realm.json:/opt/keycloak/data/import/eisenhower-realm.json:ro" \
  "$keycloak_image" start-dev --import-realm --http-relative-path=/identity >/dev/null

bootstrap=(
  docker run --rm --network "$runtime_network" --read-only
  --tmpfs "/opt/keycloak/.keycloak:mode=0700,uid=1000,gid=0"
  --entrypoint /bin/sh
  -e KC_BOOTSTRAP_ADMIN_USERNAME=contract-admin
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=contract-admin-password
  -e ADMIN_OIDC_CLIENT_SECRET=contract-admin-client-secret
  -e ADMIN_OIDC_REDIRECT_URI=https://admin.example.test/oauth2/callback
  -e IDENTITY_ADMIN_URL=http://identity-service:8080/identity
  -v "$repo_root/deploy/local/identity/ensure-admin-access.sh:/opt/eisenhower/ensure-admin-access.sh:ro"
  -v "$repo_root/deploy/local/identity/eisenhower-admin-claims.json:/opt/eisenhower/eisenhower-admin-claims.json:ro"
  -v "$repo_root/deploy/local/identity/admin-claim-mappers:/opt/eisenhower/admin-claim-mappers:ro"
  "$keycloak_image" /opt/eisenhower/ensure-admin-access.sh
)
"${bootstrap[@]}"
"${bootstrap[@]}"

kcadm=(docker exec "$identity_container" /opt/keycloak/bin/kcadm.sh)
"${kcadm[@]}" config credentials \
  --server http://127.0.0.1:8080/identity --realm master \
  --user contract-admin --password contract-admin-password >/dev/null
verification_attempt=1
while true; do
  scope_id=$("${kcadm[@]}" get client-scopes -r eisenhower \
    -q name=eisenhower-admin-claims --fields id --format csv --noquotes \
    2>/dev/null | tail -n 1 || true)
  role_name=$("${kcadm[@]}" get roles/eisenhower-admin -r eisenhower \
    --fields name --format csv --noquotes 2>/dev/null || true)
  client_state=$("${kcadm[@]}" get clients -r eisenhower \
    -q clientId=eisenhower-admin-access --fields clientId,directAccessGrantsEnabled \
    --format csv --noquotes 2>/dev/null || true)
  mapper_names=$(
    if [ -n "$scope_id" ]; then
      "${kcadm[@]}" get "client-scopes/$scope_id/protocol-mappers/models" \
        -r eisenhower --fields name --format csv --noquotes 2>/dev/null | sort || true
    fi
  )
  if [ "$role_name" = eisenhower-admin ] \
    && [ "$client_state" = eisenhower-admin-access,false ] \
    && [ "$mapper_names" = $'email\npreferred-username\nrealm-roles' ]; then
    break
  fi
  if [ "$verification_attempt" -ge 20 ]; then
    printf 'Keycloak state did not converge: scope=%s role=%s client=%s mappers=%s\n' \
      "$scope_id" "$role_name" "$client_state" "$mapper_names" >&2
    exit 1
  fi
  verification_attempt=$((verification_attempt + 1))
  sleep 1
done

echo "Keycloak admin bootstrap passed twice with the expected role, client, scope, and mappers."
