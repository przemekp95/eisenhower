#!/usr/bin/env bash
set -euo pipefail

url="${1:-}"
expected_status="${2:-}"

if [[ ! "$expected_status" =~ ^[1-5][0-9]{2}$ ]]; then
  echo "Expected status must be a three-digit HTTP status code." >&2
  exit 2
fi

if [[ "${ALLOW_INSECURE_HTTP_FOR_TESTS:-0}" == "1" ]]; then
  if [[ ! "$url" =~ ^https?:// ]]; then
    echo "Test URL must use HTTP or HTTPS." >&2
    exit 2
  fi
  allowed_protocols='=http,https'
else
  if [[ ! "$url" =~ ^https:// ]]; then
    echo "Production endpoint must use HTTPS." >&2
    exit 2
  fi
  allowed_protocols='=https'
fi

headers_file="$(mktemp)"
body_file="$(mktemp)"
error_file="$(mktemp)"
trap 'rm -f "$headers_file" "$body_file" "$error_file"' EXIT

set +e
actual_status="$(curl \
  --silent \
  --show-error \
  --connect-timeout "${HTTP_CHECK_CONNECT_TIMEOUT_SECONDS:-5}" \
  --max-time "${HTTP_CHECK_TIMEOUT_SECONDS:-20}" \
  --max-redirs 0 \
  --proto "$allowed_protocols" \
  --tlsv1.2 \
  --output "$body_file" \
  --dump-header "$headers_file" \
  --write-out '%{http_code}' \
  "$url" 2>"$error_file")"
curl_status=$?
set -e

if [[ "$curl_status" -ne 0 ]]; then
  echo "Request failed for $url: $(tr '\n' ' ' < "$error_file")" >&2
  exit 1
fi

if grep -Eqi '^location:' "$headers_file"; then
  location="$(awk 'BEGIN { IGNORECASE=1 } /^location:/ { sub(/\r$/, ""); print substr($0, index($0, ":") + 2); exit }' "$headers_file")"
  echo "Redirects are not accepted for $url (Location: ${location:-unknown})." >&2
  exit 1
fi

if [[ "$actual_status" != "$expected_status" ]]; then
  echo "Unexpected HTTP status for $url: expected $expected_status, received $actual_status." >&2
  exit 1
fi

printf 'Verified %s -> HTTP %s without redirect.\n' "$url" "$actual_status"
