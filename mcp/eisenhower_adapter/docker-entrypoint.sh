#!/bin/sh
set -eu

: "${EISENHOWER_AUDIT_HMAC_KEY:?EISENHOWER_AUDIT_HMAC_KEY is required}"
umask 077
printf '%s' "$EISENHOWER_AUDIT_HMAC_KEY" > /run/eisenhower/audit.key
unset EISENHOWER_AUDIT_HMAC_KEY

exec eisenhower-mcp
