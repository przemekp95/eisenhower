# Production acceptance

Last reviewed: 2026-08-09

This checklist deliberately separates evidence produced on a developer machine, evidence produced by GitHub Actions, and evidence from the public Mikrus runtime. Passing one level does not imply that either of the others passed.

## 1. Local candidate

The candidate is locally acceptable only when all of the following pass from a clean dependency install:

- `make verify`, including production dependency policy, builds, formatting, unit tests, integration tests and coverage gates.
- `cd web && npm run test:e2e` against the isolated real Node/Mongo test stack.
- `docker compose config --quiet` and the equivalent Mikrus Compose validation with all required variables supplied.
- an Expo Android export and a native release APK build from a disposable copy of the mobile project.
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
- The APIs use direct request/response calls. There is no production message bus, queue, webhook pipeline, CQRS split, or strict hexagonal/ports-and-adapters implementation.

## Go/no-go

Production go requires all three levels above on the same commit SHA plus a successful backup/restore rehearsal. Until the public checks and physical Android smoke pass, the correct status is “locally/CI qualified candidate”, not “production ready”.
