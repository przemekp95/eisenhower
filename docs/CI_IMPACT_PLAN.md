# CI impact planning

`ci-impact-plan/v1` selects test targets from the merge-base diff. Its JSON artifact is the audit record: it contains normalized rename/delete-aware changes, the selected multi-label targets and reasons, and a SHA-256 digest of the canonical planner input.

The planner fails closed to every target for `master`, `release/*`, the weekly schedule, workflow/action changes, lockfiles, Docker/Compose or deployment infrastructure, root build configuration, empty diffs, unknown paths/statuses, and planner or Git errors. Required jobs are never omitted: an unaffected job runs a short explicit `Not applicable` step and succeeds under its stable context name.

The dependency graph preserves the repository's real boundaries:

- backend Node HTTP, auth and task changes retain unit/coverage, executable Cucumber BDD, API-client, MCP, web integration/E2E, mobile and n8n consumer gates;
- web browser, CSRF and auth changes retain unit/coverage plus integration and Playwright;
- backend AI API, webhook, job and adapter changes retain AI, web, MCP and n8n contracts;
- shared contracts fan out across backends and consumers; API-client changes retain backend/client/browser/mobile compatibility;
- n8n changes retain signed-webhook, idempotency, retry and backend-AI job contracts;
- dependency audits are selected by owned manifests, while lockfiles and the weekly schedule run the full dependency and security set.

This is dependency-aware layered/ports-and-adapters impact selection, not a claim that the monorepo implements CQRS or a fully hexagonal architecture.

## Measured baseline and savings boundary

GitHub Actions run `31489965518` on `dev` took about 9 minutes 4 seconds end to end. Its largest jobs were native Android at 521 seconds, frontend E2E at 233 seconds and backend AI at 217 seconds; Node was 45 seconds, mobile 47 seconds, web 31 seconds, integration 28 seconds and security 25 seconds. Those are observed baseline durations, not guaranteed future timings.

Planner tests prove that a documentation-only diff selects no component targets and that owned source changes avoid unrelated jobs. The current planner PR necessarily runs full CI because it changes workflows and lockfiles. Therefore no end-to-end selective-run saving is claimed yet. Actual savings must be calculated from a later green selective GitHub run against a comparable full run, including the short runner startup cost of every not-applicable required context. Gradle, Playwright, pip and uv caches may reduce setup time, but their benefit is likewise unclaimed until cache-hit runs are observed.
