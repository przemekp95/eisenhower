#!/bin/sh
set -eu

: "${KC_BOOTSTRAP_ADMIN_USERNAME:?KC_BOOTSTRAP_ADMIN_USERNAME is required}"
: "${KC_BOOTSTRAP_ADMIN_PASSWORD:?KC_BOOTSTRAP_ADMIN_PASSWORD is required}"
: "${ADMIN_OIDC_CLIENT_SECRET:?ADMIN_OIDC_CLIENT_SECRET is required}"
: "${ADMIN_OIDC_REDIRECT_URI:?ADMIN_OIDC_REDIRECT_URI is required}"

case "$ADMIN_OIDC_REDIRECT_URI" in
  https://*/oauth2/callback) ;;
  *) echo "ADMIN_OIDC_REDIRECT_URI must be an HTTPS /oauth2/callback URL." >&2; exit 1 ;;
esac

server=${IDENTITY_ADMIN_URL:-http://identity-service:8080/identity}
attempt=1
until /opt/keycloak/bin/kcadm.sh config credentials \
  --server "$server" \
  --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" \
  --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null 2>&1; do
  if [ "$attempt" -ge 60 ]; then
    echo "Keycloak admin API did not become ready." >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 2
done

if ! /opt/keycloak/bin/kcadm.sh get roles/eisenhower-admin -r eisenhower >/dev/null 2>&1; then
  /opt/keycloak/bin/kcadm.sh create roles -r eisenhower \
    -s name=eisenhower-admin \
    -s 'description=Access to private n8n and observability consoles' >/dev/null
fi

scope_uuid=$(
  /opt/keycloak/bin/kcadm.sh get client-scopes -r eisenhower \
    -q name=eisenhower-admin-claims \
    --fields id --format csv --noquotes | tail -n 1
)
if [ -z "$scope_uuid" ]; then
  /opt/keycloak/bin/kcadm.sh create client-scopes -r eisenhower \
    -f /opt/eisenhower/eisenhower-admin-claims.json >/dev/null
  scope_uuid=$(
    /opt/keycloak/bin/kcadm.sh get client-scopes -r eisenhower \
      -q name=eisenhower-admin-claims \
      --fields id --format csv --noquotes | tail -n 1
  )
else
  /opt/keycloak/bin/kcadm.sh update "client-scopes/$scope_uuid" -r eisenhower \
    -f /opt/eisenhower/eisenhower-admin-claims.json >/dev/null
fi
test -n "$scope_uuid"

client_uuid=$(
  /opt/keycloak/bin/kcadm.sh get clients -r eisenhower \
    -q clientId=eisenhower-admin-access \
    --fields id --format csv --noquotes | tail -n 1
)
if [ -z "$client_uuid" ]; then
  /opt/keycloak/bin/kcadm.sh create clients -r eisenhower \
    -s clientId=eisenhower-admin-access \
    -s enabled=true \
    -s protocol=openid-connect >/dev/null
  client_uuid=$(
    /opt/keycloak/bin/kcadm.sh get clients -r eisenhower \
      -q clientId=eisenhower-admin-access \
      --fields id --format csv --noquotes | tail -n 1
  )
fi
test -n "$client_uuid"

/opt/keycloak/bin/kcadm.sh update "clients/$client_uuid" -r eisenhower \
  -s clientId=eisenhower-admin-access \
  -s 'name=Eisenhower admin gateway' \
  -s enabled=true \
  -s protocol=openid-connect \
  -s clientAuthenticatorType=client-secret \
  -s "secret=$ADMIN_OIDC_CLIENT_SECRET" \
  -s publicClient=false \
  -s bearerOnly=false \
  -s standardFlowEnabled=true \
  -s implicitFlowEnabled=false \
  -s directAccessGrantsEnabled=false \
  -s serviceAccountsEnabled=false \
  -s frontchannelLogout=true \
  -s "redirectUris=[\"$ADMIN_OIDC_REDIRECT_URI\"]" \
  -s 'webOrigins=[]' \
  -s 'defaultClientScopes=["eisenhower-admin-claims"]' >/dev/null

echo "Keycloak admin access role and client are reconciled."
