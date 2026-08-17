# CI impact planning

`ci-impact-plan/v1` selects test targets from the merge-base diff. Its JSON artifact is the audit record: it contains normalized rename/delete-aware changes, the selected multi-label targets and reasons, and a SHA-256 digest of the canonical planner input.

The planner fails closed to every target for `master`, `release/*`, the weekly schedule, workflow/action changes, lockfiles, Docker/Compose or deployment infrastructure, root build configuration, empty diffs, unknown paths/statuses, and planner or Git errors. `resolve-run-mode` is itself a stable required context, and every dependent required job uses an `always()` guard that fails unless the resolver succeeded and emitted a boolean target. Required component jobs are never omitted: an unaffected component job runs a short explicit `Not applicable` step and succeeds under its stable context name. Planner contracts run in every `security-lint` context; actionlint runs for full-CI inputs, production dependency audits run for the explicit `dependency-audit` target, and Trivy runs for selected executable repository surfaces. Documentation-only changes retain the required context without reinstalling or rescanning unrelated dependencies.

The governed master-to-dev fast-forward publishes the `ci/master-exact-sha-reuse` status only after every required master push job is green. A later `dev` push may reuse that immutable exact-SHA evidence and emit successful not-applicable contexts instead of repeating the heavy matrix. Missing, malformed or inapplicable reuse evidence falls back to the normal fail-closed plan.

The dependency graph preserves the repository's real boundaries:

- backend Node HTTP, auth and task changes retain unit/coverage, executable Cucumber BDD, API-client, MCP, web integration/E2E, mobile and n8n consumer gates;
- web browser, CSRF and auth changes retain unit/coverage plus integration and Playwright;
- backend AI API, webhook, job and adapter changes retain AI, web, MCP and n8n contracts;
- shared contracts fan out across backends and consumers; API-client changes retain backend/client/browser/mobile compatibility;
- n8n changes retain signed-webhook, idempotency, retry and backend-AI job contracts;
- the whole mobile application tree and the directly imported shared API client select the Android release build because Metro bundles both into the APK;
- manifest changes retain the `dependency-audit` impact label and execute npm, backend Python, MCP lockfile and mobile policy audits; executable changes retain Trivy enforcement, with fork PR SARIF retained as a normal artifact when code-scanning upload is not write-capable.

The continuous Trivy job scans repository and filesystem content. It does not substitute for the release gate, which scans every complete locally loaded first-party production image, blocks publication on LOW, MEDIUM, HIGH or CRITICAL findings, retains the vulnerability report and CycloneDX SBOM, and permits `docker push` only after the exact image passes.

This is dependency-aware layered/ports-and-adapters impact selection, not a claim that the monorepo implements CQRS or a fully hexagonal architecture.

## Measured baseline and savings boundary

GitHub Actions run `31489965518` on `dev` took about 9 minutes 4 seconds end to end. Its largest jobs were native Android at 521 seconds, frontend E2E at 233 seconds and backend AI at 217 seconds; Node was 45 seconds, mobile 47 seconds, web 31 seconds, integration 28 seconds and security 25 seconds. Those are observed baseline durations, not guaranteed future timings.

Planner tests prove that a documentation-only diff selects no component targets and that owned source changes avoid unrelated jobs. Run `31976746299` showed the selector reducing unaffected jobs to 2–5 seconds, while runs `31977628425` and `31977974655` repeated about 24.5 and 27.8 runner-minutes for the same SHA on `master` and `dev`. Exact-master reuse is intended to remove that second heavy execution, but its end-to-end saving remains unclaimed until a later synchronized GitHub run exercises the new status path. Gradle, Playwright, pip and uv cache benefits likewise remain measurement claims only when observed on comparable cache-hit runs.
