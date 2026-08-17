# Generic immutable deployment

`deploy.sh` is the only application deployment adapter. It consumes the audited
`release-manifest.json`, maps the six published repository digests into the
canonical `compose.yaml`, forces `APP_ENV=production` and `AUTH_MODE=oidc`, and
verifies the running OCI revision labels before recording the active manifest.

The target host must provide a private environment file and an explicit
`.eisenhower-deployment` ownership marker. Provider runtimes are independent:
start either `deploy/inference/compose.amd.yaml` or
`deploy/inference/compose.nvidia.yaml` separately and expose only the three-value
`INFERENCE_BASE_URL`, `INFERENCE_API_KEY`, `INFERENCE_ALLOWED_HOSTS` contract to
the application network. The optional private n8n service is enabled only with
the `n8n` profile.

AWS ECS was removed from the supported contract because the historical action
only forced the current task definition to restart. It never bound a task
definition or running task to the requested release SHA/digests and therefore
could not prove deployment of the released artifacts.

`backup.sh` and confirmation-gated `restore.sh` preserve canonical Mongo data,
private audit/n8n/identity/job volumes and the active immutable release manifest
with checksums. Qdrant is deliberately excluded because Mongo remains canonical;
the projection must be rebuilt or restored through the separately verified
Qdrant snapshot/reindex procedure before traffic acceptance.
