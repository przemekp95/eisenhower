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
    -s 'description=Minimal identity and realm-role claims consumed by the admin access proxy' \
    -s protocol=openid-connect >/dev/null
fi
test -n "$scope_uuid"

reconcile_mapper() {
  mapper_name=$1
  mapper_file=$2
  case "$mapper_name" in
    preferred-username)
      mapper_type=oidc-usermodel-property-mapper
      mapper_config='{"user.attribute":"username","claim.name":"preferred_username","jsonType.label":"String","access.token.claim":"true","id.token.claim":"true","userinfo.token.claim":"true"}'
      ;;
    email)
      mapper_type=oidc-usermodel-property-mapper
      mapper_config='{"user.attribute":"email","claim.name":"email","jsonType.label":"String","access.token.claim":"true","id.token.claim":"true","userinfo.token.claim":"true"}'
      ;;
    realm-roles)
      mapper_type=oidc-usermodel-realm-role-mapper
      mapper_config='{"claim.name":"realm_access.roles","jsonType.label":"String","multivalued":"true","usermodel.realmRoleMapping.rolePrefix":"","access.token.claim":"true","id.token.claim":"true","userinfo.token.claim":"true"}'
      ;;
    *) echo "Unsupported admin claim mapper: $mapper_name" >&2; exit 1 ;;
  esac
  mapper_uuid=$(
    /opt/keycloak/bin/kcadm.sh get \
      "client-scopes/$scope_uuid/protocol-mappers/models" -r eisenhower \
      --fields id,name --format csv --noquotes \
      | grep -F ",$mapper_name" | cut -d, -f1 | tail -n 1
  )
  if [ -z "$mapper_uuid" ]; then
    /opt/keycloak/bin/kcadm.sh create \
      "client-scopes/$scope_uuid/protocol-mappers/models" -r eisenhower \
      -f "$mapper_file" >/dev/null
  else
    /opt/keycloak/bin/kcadm.sh update \
      "client-scopes/$scope_uuid/protocol-mappers/models/$mapper_uuid" -r eisenhower \
      -s protocol=openid-connect \
      -s "protocolMapper=$mapper_type" \
      -s consentRequired=false \
      -s "config=$mapper_config" >/dev/null
  fi
}

reconcile_mapper preferred-username /opt/eisenhower/admin-claim-mappers/preferred-username.json
reconcile_mapper email /opt/eisenhower/admin-claim-mappers/email.json
reconcile_mapper realm-roles /opt/eisenhower/admin-claim-mappers/realm-roles.json

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
