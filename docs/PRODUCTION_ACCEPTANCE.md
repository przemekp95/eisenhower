# Production acceptance

Last reviewed: 2026-08-10

This checklist deliberately separates evidence produced on a developer machine, evidence produced by GitHub Actions, and evidence from the public Mikrus runtime. Passing one level does not imply that either of the others passed.

## 1. Local candidate

The candidate is locally acceptable only when all of the following pass from a clean dependency install:

- `make verify`, including production dependency policy, builds, formatting, unit tests, integration tests and coverage gates.
- `cd web && npm run test:e2e` against the isolated real Node/Mongo test stack.
- `docker compose config --quiet` and the equivalent Mikrus Compose validation with all required variables supplied.
- an Expo Android export and a native APK build from a disposable copy of the mobile project;
- the production-signing path is exercised with a disposable non-debug certificate, while the real production certificate remains an external release gate.
- `git diff --check`.

Security behavior must also be covered by executable tests:

- every non-health Node and AI route requires a valid Bearer credential;
- all AI training-data writes (including feedback), retraining and provider management require the distinct administrator credential;
- unsafe browser requests from an untrusted `Origin` receive `403`;
- CORS uses an explicit production allowlist and never enables credentials;
- credentials are entered at runtime and are not persisted or embedded in web/mobile bundles.

## 2. CI candidate

The GitHub commit is acceptable only when all CI jobs pass on the exact commit SHA:

- `branch-policy`
- `security-lint`
- `test-backend-node`
- `test-frontend`
- `test-frontend-integration`
- `test-frontend-e2e`
- `test-backend-ai`
- `test-mobile`
- `test-mobile-native-android`

Branch protection for `dev` and `master` must require those checks before merge. A local workflow edit does not change GitHub rulesets; rulesets must be verified after the change is pushed.

The release workflow starts only after a successful `CI` push run for `master`, checks out its exact SHA, and publishes images under that immutable SHA. `latest` is not a deployment input.

The native Android CI job produces only a debug-signed installability candidate. A releasable APK is a distinct post-`master` artifact: its signing key is supplied from GitHub secrets, its public certificate SHA-256 is pinned in `ANDROID_RELEASE_CERT_SHA256`, APK Signature Scheme v2 is verified, and an Android Debug certificate is rejected. The production keystore must have an independently retained recovery copy before release.

## 3. Public runtime

The release is publicly accepted only after the deployment job passes all of these checks over HTTPS:

- `GET /health` returns `200` from the frontend;
- `GET /api/health` returns `200` from the Node service;
- `GET /ai/` returns `200` from the AI service;
- unauthenticated task/AI reads and writes return `401`;
- a valid user token can create, read, update and delete a disposable task;
- a user token receives `403` on AI administration routes;
- an administrator token can read provider/training status;
- MiniLM classification and Tesseract OCR complete successfully;
- the browser loads without mixed content and state-changing requests work only from the configured public origin;
- the Android APK can be installed on a physical device and completes task CRUD plus AI classification against the public HTTPS endpoints.

The deploy script must roll back automatically when container readiness or the public smoke fails. `deploy/mikrus/backup.sh` and confirmation-gated `restore.sh` cover MongoDB and AI data, but an independently verified backup/restore drill is still required before the service can be called disaster-recovery ready.

## Dependency exception

Backend Node and web production audits must report zero high or critical vulnerabilities.

The current Expo/Metro build chain carries two high-severity `image-size` advisories ([GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) and [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)). They are transitive build-tool findings and the registry currently has no patched `image-size` release. `npm run audit:production` permits only that exact dependency chain, rejects every critical or new advisory, and expires after 2026-10-31. It must be removed as soon as Expo/Metro ships a patched chain.

## Architecture and methodology claims

- New security, deployment and dependency-policy work must show a failing test before the implementation and a passing test afterward. Historical repository-wide TDD adoption is not proven by the presence of tests.
- The system is a pragmatic layered monorepo. It has useful domain names and service boundaries, but no evidenced bounded-context model, aggregate discipline, or strict domain/application/infrastructure separation; it must not be marketed as full DDD.
- The repository has integration and end-to-end tests but no Gherkin, executable Given-When-Then scenarios, or living feature documentation; it must not be marketed as BDD.
- The supported runtime uses direct HTTP request/response calls. Experimental code contains a signed webhook, a durable SQLite job queue, a worker and RAG-oriented ports/adapters, but none is activated in the supported Mikrus topology; it is therefore not evidence of a production message bus, webhook pipeline or strict repository-wide hexagonal architecture.
- There is no CQRS read/write model split or event sourcing. The MiniLM/OCR release path remains pragmatic layered code; the experimental RAG package has useful ports and adapters but does not make the whole monorepo hexagonal.

## Current evidence snapshot

Evidence is deliberately scoped; later rows never inherit a pass from earlier rows.

| Level | Status on 2026-08-10 | Evidence |
| --- | --- | --- |
| LOCAL | green for the current candidate worktree, excluding external release credentials | After integrating the latest `dev`, `make verify` passed: Node 66 tests at 100%, web 125 unit plus 2 integration tests at 100%, AI 206 passed/2 explicitly skipped at 89% coverage, and mobile 95 tests above its coverage gates. Playwright passed 2/2 against an isolated real Node/Mongo stack. Root and Mikrus Compose configurations validated with disposable non-secret values. The Android production-signing path was exercised end to end against the real Expo-generated Gradle project using a one-time non-debug certificate: `assembleRelease`, v2 signature verification, pinned certificate comparison, public endpoint embedding and loopback rejection all passed. The verifier independently rejected the earlier debug-signed CI artifact. This disposable key is not production evidence. The development classifier report is `backend-ai/evaluation/development-benchmark-20260810.json`; its development gate passes and its production gate fails closed. |
| CI | green through published `dev` SHA `f5c7ddbcfe84fd701b59c674af5c5530486640ea` | Push run `31383971990` passed all nine required jobs after PR #146. The earlier evaluation merge SHA `7c97b40a83ab651f26c04cb61e70d11dc8ec1d32` also passed all nine in run `31382275926`; its downloaded APK is structurally valid and v2-signed, but its signer is `CN=Android Debug`, so it proves CI installability only and is not a production release APK. Branch rulesets for `dev` and `master` require all nine checks. The Android-signing and exact-HTTP candidate described here still requires its own PR CI before merge. |
| PUBLIC RUNTIME | red | A fresh no-follow check at 2026-08-10 13:29 Europe/Warsaw showed that `https://tymon169-8081.mikrus.cloud` returns `301` to `/error-wykres/` for frontend, Node health and AI health/readiness paths. Host inspection confirmed that no Eisenhower container is running, while both data volumes remain present. The final page is a generic Cloudflare-served error page. The deployment smoke previously used `curl --fail`, which accepts `301`; the candidate now uses an exact-status, no-redirect verifier so this failure cannot be reported green. The expired `mikrus-tymon169` Actions registration was backed up, re-registered, enabled in systemd and independently observed `online`/idle in GitHub. |
| HUMAN EVALUATION | blocked | The 240-item blind PL/EN packet exists, but both human annotation files are blank. No agreement, adjudication, frozen production dataset or approved SHA exists. |
| PHYSICAL ANDROID | unverified | A debug-signed CI candidate alone does not prove a production-signed installation or task CRUD plus classification on a physical device. The production keystore secrets and pinned public certificate digest are not configured yet. |
| DATA BACKUP/RESTORE | data drill green; application rollback pending | With all Eisenhower containers stopped, the preserved `eisenhower_mongodb_data` and `eisenhower_ai_data` volumes were independently archived to `/root/eisenhower-backups/20260810T114224Z` with permissions `0600`. MongoDB contained 146 files and AI data 4 files. Both archives passed gzip and archive SHA-256 checks, were restored to isolated disposable Docker volumes, and the restored per-file SHA-256 manifests matched their sources exactly. Only the temporary restore volumes were removed after comparison; the source volumes and verified archives remain. Rollback of a running application SHA still requires a new approved release. |

## Go/no-go

Production go requires all three levels above on the same commit SHA plus a successful backup/restore rehearsal. Until the public checks and physical Android smoke pass, the correct status is “locally/CI qualified candidate”, not “production ready”.
