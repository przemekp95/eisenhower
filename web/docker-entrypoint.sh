#!/bin/sh
set -eu

escape_json() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

api_url="$(escape_json "${VITE_API_URL:-http://localhost:3001}")"
ai_api_url="$(escape_json "${VITE_AI_API_URL:-http://localhost:8000}")"
oidc_issuer="$(escape_json "${VITE_OIDC_ISSUER:-}")"
oidc_client_id="$(escape_json "${VITE_OIDC_CLIENT_ID:-}")"
oidc_redirect_uri="$(escape_json "${VITE_OIDC_REDIRECT_URI:-}")"
oidc_scopes="$(escape_json "${VITE_OIDC_SCOPES:-openid profile email tasks:read tasks:write calendar:read calendar:write knowledge:read ai:analyze}")"
config_version="$(date +%s)"

cat > /usr/share/nginx/html/runtime-config.js <<EOF
window.__APP_CONFIG__ = {
  apiUrl: "${api_url}",
  aiApiUrl: "${ai_api_url}",
  oidcIssuer: "${oidc_issuer}",
  oidcClientId: "${oidc_client_id}",
  oidcRedirectUri: "${oidc_redirect_uri}",
  oidcScopes: "${oidc_scopes}"
};
EOF

sed -i "s/__RUNTIME_CONFIG_VERSION__/${config_version}/g" /usr/share/nginx/html/index.html

exec nginx -g 'daemon off;'
