# Release base image policy

Last reviewed: 2026-08-16

Readable version tags stay beside OCI index digests so maintainers can see the intended release line while Docker pulls immutable content. The digest is the release control; the tag is update context.

## Current supported release inputs

| Input | Current policy | Evidence limit |
| --- | --- | --- |
| Web build/development Node | `node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43` | The OCI index contains at least `linux/amd64` and `linux/arm64/v8`; both stages intentionally share it. |
| Web production Nginx | `nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752` | The OCI index contains at least `linux/amd64` and `linux/arm64/v8`. |
| Canonical MongoDB | Supply an approved digest through `MONGODB_IMAGE` | Mongo is canonical; refresh requires backup/restore rehearsal and runtime acceptance. |

These registry resolutions were checked on the review date. A digest fixes content; it does not prove vulnerability status, runtime compatibility, data migration safety or a successful target deployment.

The backend Node and AI Dockerfiles are also release build inputs. They use the same digest-pinned Wolfi base and install explicitly pinned Node 24 and Python 3.11 packages; their package-version and image-security checks remain separate release gates.

## Controlled update procedure

1. Select a supported tag; do not remove the readable major/runtime tag.
2. Resolve its top-level multi-platform digest with `docker buildx imagetools inspect <tag>`.
3. Inspect `<tag>@sha256:<digest>` and confirm every supported platform, including `linux/amd64` and `linux/arm64/v8` where applicable. Never copy an architecture-specific child digest into a multi-arch release input.
4. Update every occurrence of the same base together. Run the web base-image policy test, build the web targets, and render canonical Compose for development and production.
5. Review upstream release notes and vulnerability results. Digest refreshes are normal dependency changes and require the usual tests and review; automation may open the change but must not bypass these gates.

## Deliberate non-pins and remaining gaps

- First-party release images are published only after the aggregate scan gate. `release-manifest.json` binds the exact master SHA to every registry RepoDigest and the checksums of its Trivy/SBOM evidence; `deploy/generic/deploy.sh` consumes those digests directly.
- Infrastructure images in `compose.yaml` remain explicit environment inputs. Their digest qualification is separate from first-party image publication and must not be inferred from a successful application release.
- `deploy/inference/compose.nvidia.yaml` and `compose.amd.yaml` remain standalone provider stacks. Their hardware/model qualification and immutable provider image selection are separate physical gates, not application release claims.
