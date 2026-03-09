#!/bin/sh
set -eu

escape_json() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

api_url="$(escape_json "${VITE_API_URL:-http://localhost:3001}")"
ai_api_url="$(escape_json "${VITE_AI_API_URL:-http://localhost:8000}")"

cat > /usr/share/nginx/html/runtime-config.js <<EOF
window.__APP_CONFIG__ = {
  apiUrl: "${api_url}",
  aiApiUrl: "${ai_api_url}"
};
EOF

exec nginx -g 'daemon off;'
