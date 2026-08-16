#!/bin/sh
set -eu

rag_ready="${1:-false}"
test "$rag_ready" = true || test "$rag_ready" = false || {
  echo "RAG readiness must be true or false" >&2
  exit 2
}
rag_credential_id="${N8N_RAG_HEADER_AUTH_CREDENTIAL_ID:-}"
if test -n "${N8N_USER_FOLDER:-}"; then
  database_path="$N8N_USER_FOLDER/.n8n/database.sqlite"
else
  database_path=/home/node/.n8n/database.sqlite
fi
database_backup=/reconcile/database.sqlite.before-reconcile

mkdir -p /reconcile
database_existed=false
if test -f "$database_path"; then
  cp "$database_path" "$database_backup"
  database_existed=true
fi
restore_database() {
  status=$?
  trap - EXIT HUP INT TERM
  if test "$status" -ne 0 && test "$database_existed" = true; then
    cp "$database_backup" "$database_path"
    rm -f "${database_path}-wal" "${database_path}-shm"
    echo "Restored the n8n database after reconcile failure" >&2
  elif test "$status" -ne 0; then
    rm -f "$database_path" "${database_path}-wal" "${database_path}-shm"
    echo "Removed the failed initial n8n database" >&2
  fi
  rm -f "$database_backup"
  exit "$status"
}
trap restore_database EXIT HUP INT TERM

if ! n8n export:workflow --all --output=/reconcile/current.json; then
  if ! listed_workflows="$(n8n list:workflow --onlyId)"; then
    echo "Unable to verify that the n8n database is empty" >&2
    exit 1
  fi
  if printf '%s\n' "$listed_workflows" | grep -Eq '^[0-9A-Za-z-]{8,36}$'; then
    echo "Workflow export failed for a non-empty n8n database" >&2
    exit 1
  fi
  printf '[]\n' > /reconcile/current.json
fi
if test "$rag_ready" = true; then
  node /repo-n8n/scripts/verify-runtime-credential.cjs \
    "$database_path" "$rag_credential_id"
fi
node /repo-n8n/scripts/reconcile-runtime.mjs \
  --workflows /workflows \
  --current /reconcile/current.json \
  --output /reconcile \
  --rag-credential-id "$rag_credential_id" \
  --rag-ready "$rag_ready"

plan_ids() {
  node -e "const p=require('/reconcile/plan.json'); for (const id of p[process.argv[1]]) console.log(id)" "$1"
}

plan_ids unpublishIds | while IFS= read -r workflow_id; do
  test -n "$workflow_id" && n8n unpublish:workflow --id="$workflow_id"
done

node /repo-n8n/scripts/delete-workflow-duplicates.cjs \
  "$database_path" /reconcile/plan.json

if test -n "$(plan_ids importIds)"; then
  n8n import:workflow --input=/reconcile/import.json
fi

plan_ids publishIds | while IFS= read -r workflow_id; do
  test -n "$workflow_id" && n8n publish:workflow --id="$workflow_id"
done

n8n export:workflow --all --output=/reconcile/verified.json
node /repo-n8n/scripts/reconcile-runtime.mjs \
  --workflows /workflows \
  --current /reconcile/verified.json \
  --output /reconcile/verified-plan \
  --rag-credential-id "$rag_credential_id" \
  --rag-ready "$rag_ready" >/dev/null
node -e '
  const plan = require("/reconcile/verified-plan/plan.json");
  const remaining = Object.values(plan).reduce((count, ids) => count + ids.length, 0);
  if (remaining !== 0) throw new Error(`n8n reconcile did not converge: ${JSON.stringify(plan)}`);
'

trap - EXIT HUP INT TERM
rm -f "$database_backup"
