#!/bin/sh
set -eu

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
runtime_dir="$(mktemp -d)"
chmod 0700 "$runtime_dir"
runtime_parent="$(dirname -- "$runtime_dir")"

cleanup() {
  case "$runtime_dir" in
    "$runtime_parent"/tmp.*)
      test -d "$runtime_dir" && find "$runtime_dir" -xdev -depth -delete
      ;;
    *)
      echo "Refusing to clean unexpected rehearsal path: $runtime_dir" >&2
      ;;
  esac
}
trap cleanup EXIT HUP INT TERM

run_n8n() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e N8N_USER_FOLDER=/reconcile \
    -e N8N_ENCRYPTION_KEY=rehearsal-only-32-byte-secret-key \
    -e N8N_DIAGNOSTICS_ENABLED=false \
    -e EISENHOWER_NODE_INTERNAL_API_URL=http://127.0.0.1:9 \
    -e EISENHOWER_INTERNAL_API_URL=http://127.0.0.1:9 \
    -e EISENHOWER_INTERNAL_API_TOKEN=rehearsal-only \
    -e CALENDAR_INTERNAL_HMAC_KEY=rehearsal-only-32-byte-hmac-key \
    -e GOOGLE_CALENDAR_WEBHOOK_URL=https://example.invalid/eisenhower/google-calendar/webhook \
    -e N8N_BLOCK_ENV_ACCESS_IN_NODE=false \
    -e NODE_FUNCTION_ALLOW_BUILTIN=crypto \
    -v "$runtime_dir:/reconcile" \
    -v "$root_dir/n8n:/repo-n8n:ro" \
    -v "$root_dir/n8n/workflows:/workflows:ro" \
    n8nio/n8n:2.4.6 "$@"
}

run_reconcile() {
  docker run --rm \
    --entrypoint /repo-n8n/scripts/reconcile-runtime-container.sh \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e N8N_USER_FOLDER=/reconcile \
    -e N8N_ENCRYPTION_KEY=rehearsal-only-32-byte-secret-key \
    -e N8N_DIAGNOSTICS_ENABLED=false \
    -e EISENHOWER_NODE_INTERNAL_API_URL=http://127.0.0.1:9 \
    -e EISENHOWER_INTERNAL_API_URL=http://127.0.0.1:9 \
    -e EISENHOWER_INTERNAL_API_TOKEN=rehearsal-only \
    -e CALENDAR_INTERNAL_HMAC_KEY=rehearsal-only-32-byte-hmac-key \
    -e GOOGLE_CALENDAR_WEBHOOK_URL=https://example.invalid/eisenhower/google-calendar/webhook \
    -e N8N_BLOCK_ENV_ACCESS_IN_NODE=false \
    -e NODE_FUNCTION_ALLOW_BUILTIN=crypto \
    -v "$runtime_dir:/reconcile" \
    -v "$root_dir/n8n:/repo-n8n:ro" \
    -v "$root_dir/n8n/workflows:/workflows:ro" \
    n8nio/n8n:2.4.6 false
}

run_reconcile

# Prove that an active local edit is detected and repaired, and that a legacy
# same-name import is removed rather than accumulating forever.
node -e '
  const fs = require("node:fs");
  const workflows = require(process.argv[1]);
  const outbound = structuredClone(workflows.find((item) => item.id === "5941556e-b985-5e90-bc92-3d10f5335996"));
  const duplicate = structuredClone(workflows.find((item) => item.id === "071f5a26-7b5d-5aa1-9f5b-f49a37855151"));
  outbound.settings.timezone = "Europe/London";
  duplicate.id = "stale-calendar-inbound-duplicate";
  fs.writeFileSync(process.argv[2], JSON.stringify([outbound, duplicate]));
' "$runtime_dir/import.json" "$runtime_dir/drift-and-duplicate.json"
run_n8n import:workflow --input=/reconcile/drift-and-duplicate.json
run_n8n publish:workflow --id=5941556e-b985-5e90-bc92-3d10f5335996

drift_log="$runtime_dir/drift-reconcile.log"
run_reconcile | tee "$drift_log"
grep -q '"activeDriftIds":\["5941556e-b985-5e90-bc92-3d10f5335996"\]' "$drift_log"
grep -q 'stale-calendar-inbound-duplicate' "$drift_log"

no_op_log="$runtime_dir/no-op-reconcile.log"
run_reconcile | tee "$no_op_log"
grep -q '"importIds":\[\]' "$no_op_log"

active_ids="$(run_n8n list:workflow --active=true --onlyId \
  | grep -E '^[0-9a-f-]{36}$' | sort)"
expected_ids='071f5a26-7b5d-5aa1-9f5b-f49a37855151
49e68dfe-b1ac-5d91-89ab-45c27e491fbb
5941556e-b985-5e90-bc92-3d10f5335996'
test "$active_ids" = "$expected_ids" || {
  echo "Unexpected active workflow set:" >&2
  echo "$active_ids" >&2
  exit 1
}

log_file="$runtime_dir/start.log"
set +e
timeout 12 docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e N8N_USER_FOLDER=/reconcile \
  -e N8N_ENCRYPTION_KEY=rehearsal-only-32-byte-secret-key \
  -e N8N_DIAGNOSTICS_ENABLED=false \
  -e EISENHOWER_NODE_INTERNAL_API_URL=http://127.0.0.1:9 \
  -e EISENHOWER_INTERNAL_API_URL=http://127.0.0.1:9 \
  -e EISENHOWER_INTERNAL_API_TOKEN=rehearsal-only \
  -e CALENDAR_INTERNAL_HMAC_KEY=rehearsal-only-32-byte-hmac-key \
  -e GOOGLE_CALENDAR_WEBHOOK_URL=https://example.invalid/eisenhower/google-calendar/webhook \
  -e N8N_BLOCK_ENV_ACCESS_IN_NODE=false \
  -e NODE_FUNCTION_ALLOW_BUILTIN=crypto \
  -v "$runtime_dir:/reconcile" \
  n8nio/n8n:2.4.6 start >"$log_file" 2>&1
start_status=$?
set -e
test "$start_status" = 124 || test "$start_status" = 0 || {
  cat "$log_file" >&2
  exit "$start_status"
}
if grep -E 'WorkflowActivationError|There was a problem activating workflow|Unknown node type' "$log_file"; then
  cat "$log_file" >&2
  exit 1
fi
grep -q 'Editor is now accessible' "$log_file"
echo "n8n 2.4.6 disposable runtime rehearsal passed"
