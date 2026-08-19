#!/bin/sh
set -eu
umask 077

test "$#" -eq 2 || {
  echo "Usage: import-rag-credential.sh DATABASE_PATH CREDENTIAL_ID" >&2
  exit 2
}
database_path=$1
credential_id=$2
credential_value=${N8N_RAG_HEADER_AUTH_VALUE:?N8N_RAG_HEADER_AUTH_VALUE is required}
credential_header=${N8N_RAG_HEADER_AUTH_NAME:-Authorization}

temporary_dir=$(mktemp -d)
chmod 0700 "$temporary_dir"
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  find "$temporary_dir" -xdev -depth -delete
  exit "$status"
}
trap cleanup EXIT HUP INT TERM
credential_file="$temporary_dir/credential.json"

CREDENTIAL_FILE="$credential_file" \
CREDENTIAL_ID="$credential_id" \
CREDENTIAL_HEADER="$credential_header" \
CREDENTIAL_VALUE="$credential_value" \
node - <<'NODE'
const fs = require('node:fs');
const payload = [{
  id: process.env.CREDENTIAL_ID,
  name: 'Eisenhower private RAG internal auth',
  type: 'httpHeaderAuth',
  data: {
    name: process.env.CREDENTIAL_HEADER,
    value: process.env.CREDENTIAL_VALUE,
  },
}];
fs.writeFileSync(
  process.env.CREDENTIAL_FILE,
  `${JSON.stringify(payload)}\n`,
  { encoding: 'utf8', mode: 0o600, flag: 'wx' },
);
NODE

n8n import:credentials --input="$credential_file"
rm -f "$credential_file"
node /repo-n8n/scripts/verify-runtime-credential.cjs \
  "$database_path" "$credential_id"
