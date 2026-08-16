# Release base image policy

Last reviewed: 2026-08-16

Readable version tags stay beside OCI index digests so maintainers can see the intended release line while Docker pulls immutable content. The digest is the release control; the tag is update context.

## Current supported release inputs

| Input | Current policy | Evidence limit |
| --- | --- | --- |
| Web build/development Node | `node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43` | The OCI index contains at least `linux/amd64` and `linux/arm64/v8`; both stages intentionally share it. |
| Web production Nginx | `nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752` | The OCI index contains at least `linux/amd64` and `linux/arm64/v8`. |
| Mikrus MongoDB | `mongo:7-jammy@sha256:04582c3a144d088f841c446abfc19f79adcefa8bd00ad4a7fb18e27b9585c5d6` | The OCI index contains `linux/amd64` and `linux/arm64/v8`. |

These registry resolutions were checked on the review date. A digest fixes content; it does not prove vulnerability status, runtime compatibility, data migration safety or a successful target deployment.

The backend Node and AI Dockerfiles are also release build inputs. They use the same digest-pinned Wolfi base and install explicitly pinned Node 24 and Python 3.11 packages; their package-version and image-security checks remain separate release gates.

## Controlled update procedure

1. Select a supported tag; do not remove the readable major/runtime tag.
2. Resolve its top-level multi-platform digest with `docker buildx imagetools inspect <tag>`.
3. Inspect `<tag>@sha256:<digest>` and confirm every supported platform, including `linux/amd64` and `linux/arm64/v8` where applicable. Never copy an architecture-specific child digest into a multi-arch release input.
4. Update every occurrence of the same base together. Run the web base-image policy test, build the web `production` and `development` targets, and render both root and Mikrus Compose configurations.
5. Review upstream release notes and vulnerability results. Digest refreshes are normal dependency changes and require the usual tests and review; automation may open the change but must not bypass these gates.

## Deliberate non-pins and remaining gaps

- `deploy/mikrus/docker-compose.yml` consumes first-party images through `IMAGE_TAG`, which the release workflow supplies as the full Git commit SHA. This avoids `latest` but is not immutable: registry tags can move, Compose checks only that the variable is non-empty, and backup/restore records the tag rather than `RepoDigests`. Per-image digest deployment requires coordinated workflow outputs, deployment variables and persisted rollback state; the required `.github/**` workflow change is outside this slice.
- Root `docker-compose.yml` is the local integration/development stack. Its MongoDB, Redis, Qdrant, MinIO, n8n, Nginx, Prometheus and Grafana references are not public Mikrus release inputs. They remain tag-based so this slice does not freeze local/experimental tools or accidentally narrow their multi-architecture behavior. They must not be cited as reproducible release inputs.
- `deploy/inference/compose.nvidia.yaml` and `compose.amd.yaml` are disabled, contract-only vLLM profiles. Hardware, model, supported runtime and multi-architecture selection are unresolved, and `docs/ai-rebuild/inference-portability.md` already marks the digest pending. Pinning a guessed digest would misrepresent an approved runtime; select and verify it only after the TASK-015 live gate.
