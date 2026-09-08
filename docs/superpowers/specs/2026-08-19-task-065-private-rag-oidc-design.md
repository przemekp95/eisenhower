# TASK-065 Private Generative RAG and OIDC Entry Design

## Status and relationship to the existing design

This document is the owner-approved activation addendum to
`2026-08-19-task-065-product-calendar-ai-design.md`. It changes only two
decisions from that design:

- the private, allowlisted single-turn grounded response may now be activated
  after all checksum, runtime, evaluation, and rollback gates in this document
  pass; and
- OIDC entry becomes automatic, while the credential screen becomes an
  OIDC-error recovery surface rather than a second apparent login.

The earlier task-first, OCR, bulk import, Calendar, security, architecture, and
evidence-boundary decisions remain in force. This addendum does not authorize a
public release, public RAG exposure, MAG, conversational history, or any memory
read, write, augmentation, or response capability.

## Outcome

The private Eisenhower runtime answers one task-scoped question from an
approved repository corpus, shows claim-bound sources, permits an editable
preview, and applies content to the selected task description only after the
user confirms. Unsupported questions produce an honest no-answer result.

OIDC users enter through Keycloak without first seeing a manual credential
form. The local non-OIDC mode retains its manual bearer-token entry.

## OIDC state machine and recovery UX

The web application derives one explicit authentication mode from validated
runtime configuration.

In OIDC mode, a fresh load with no callback parameters, no established token,
and no recorded authorization error calls `beginOidcLogin` exactly once for
that attempt. A synchronous guard is set before navigation begins so React
Strict Mode, rerenders, or repeated effects cannot start a second redirect.
The guard is cleared only when a new deliberate retry begins or the application
resolves a completed callback. The callback continues to validate state,
exchange the PKCE verifier, retain the bearer token in memory, and remove
authorization parameters from the browser URL.

An OIDC cancellation, rejection, invalid callback, exchange failure, or bounded
redirect-start failure renders a recovery `CredentialGate`. It contains a
localized explanation, a retry action that starts a new guarded OIDC attempt,
and `LanguageSwitcher`. It contains no access-code field, token terminology,
card-memory wording, or manual-token input.

In non-OIDC mode only, `CredentialGate` keeps the existing manual bearer-token
entry and its appropriate local-mode copy. Tests cover first entry, Strict Mode
and rerender stability, PKCE callback success, every error transition, retry,
language switching, and separation of OIDC versus manual-token controls.

## Grounded-answer boundary

The browser calls the existing typed knowledge-answer client with an OIDC
Bearer token and `credentials: 'omit'`. The gateway exposes only the existing
bounded answer route. FastAPI remains the owner of request validation,
tenant/user/project authorization, canonical Mongo revalidation, retrieval,
prompt construction, generator invocation, output-schema validation, citation
binding, abstention, timeouts, circuit breaking, fallbacks, and aggregate
metrics.

The answer operation is a side-effect-free query. Applying a preview remains a
separate revision-guarded task update command through the Node API using the
existing owner checks and `If-Match` behavior. No generator can write a task,
call a tool, enqueue a job, or bypass the preview.

Browser security remains bearer-based rather than cookie-authenticated, so the
application does not introduce a cookie-CSRF surface. Existing CORS and trusted
Origin enforcement remains defense in depth. No secret, raw document body,
prompt, or generated answer is added to unrestricted logs or metrics.

## Private generator and reranker topology

The selected design creates pinned private inference and reranking services in
the controlled blue-green deployment network. The application uses its
existing provider-neutral OpenAI-compatible generation port; provider-specific
HTTP, authentication, model naming, and response mapping remain confined to
the infrastructure adapter.

The generator uses the previously evaluated Qwen model family only after its
exact model revision, image digest, tokenizer/template inputs, response schema,
and runtime flags are recorded in the release evidence. The reranker likewise
uses its exact evaluated model revision and image digest. MiniLM plus the
PyTorch MLP remains the independent quadrant classifier and is never described
or routed as a generator.

Both services have no host-published port. They require internal service
authentication, the deployment network allowlist, bounded request and phase
timeouts, bounded input/output tokens, bounded concurrency, health probes,
resource limits, and fail-closed startup validation. The knowledge service's
existing circuit breaker and fallback path converts generator or reranker
failure into a stable unavailable/no-answer outcome without disabling task
CRUD, Calendar, OCR, bulk import, or quadrant classification.

The older `eisenhower-local-production` inference and reranker are migration
sources and rollback evidence only. They are not stopped, removed, or connected
cross-network as a permanent dependency. Their images, volumes, configuration,
and routing remain intact until the replacement passes authenticated answer,
no-answer, restart, and routing-rollback checks.

## Checksum-bound corpus and projection

Only files already enumerated by the repository corpus policy are eligible.
No arbitrary local file, external URL, browser content, chat transcript, task
history, or Calendar data enters the corpus.

The final candidate tree mechanically regenerates the corpus manifest after all
source edits. A fresh owner-decision packet binds the exact manifest SHA-256,
each eligible source path and byte digest, corpus version, retention and consent
policy, tenant `eisenhower-owner`, project scope, canonical schema, embedding
and reranker revisions, target collection, evaluation inputs, final source SHA,
deployment identity, cohort, expiry, stop thresholds, and rollback target. Any
post-decision source or manifest drift fails closed and requires a new binding.

Ingestion first creates canonical Mongo records through the governed extraction
and validation path, then projects them into a new versioned Qdrant collection.
The collection is not aliased to the response path until canonical counts,
point counts, checksums, reconciliation drift, tenant/project/ACL isolation,
tombstone/version behavior, and idempotent second-run results pass. Retrieval
must revalidate every vector candidate against Mongo before returning content.

Evaluation covers the frozen approved cases plus live authenticated checks for
answerable PL/EN questions, exact identifiers, citation/source-preview binding,
unsupported and prompt-injection questions, stale/forbidden documents,
cross-user and cross-project isolation, repeat ingestion, bounded latency, and
resource limits. No-answer correctness and citation validity are hard gates;
generated fluency cannot compensate for a failed security or grounding gate.

## n8n reconciliation

n8n remains asynchronous orchestration, not the synchronous answer engine and
not a direct Qdrant writer. The two RAG workflows remain inactive until the
knowledge service reports live retrieval and generator readiness against the
new projection.

Their credential is created or reconciled through the supported secret path,
uses the least-privileged internal endpoint and authentication, and is verified
without logging its value. Workflow definitions are reconciled by immutable
identity and checked for expected inactive state before activation. Activation
then proves the bounded job contract, idempotency/replay handling, failure
visibility, and absence of direct provider or arbitrary-execution access.

Calendar workflows and credentials are not modified except when a shared n8n
reconciliation contract requires a compatibility fix, which must have its own
regression test.

## Activation decision and rollback

Retrieval may be enabled for the approved tenant/project after projection and
isolation gates pass. Generation and response may be enabled only for the
explicit response-user allowlist containing
`f226f9de-1c01-4a36-9eb3-77f3313e3456`, and only when a promotion record binds:

- final source and deployment SHA;
- corpus manifest and projection identity;
- generator, reranker, embedding, prompt, and schema revisions;
- activation time and expiry;
- latency, error, circuit-open, citation, no-answer, resource, and security stop
  thresholds; and
- the preserved blue-green routing target and rollback commands.

All memory write, retrieval, response, augmentation, and long-term history
flags remain false in every service. All MAG flags and workflows remain false
or inactive. These invariants are asserted in rendered Compose, runtime
environment inspection, capabilities, and smoke evidence.

Rollback first changes only private gateway routing to the preserved
`eisenhower-e2eff0` runtime on `127.0.0.1:8990`, then verifies health and
authenticated non-RAG product behavior. The independently preserved
`eisenhower-ddb83c` runtime on `127.0.0.1:8890` remains a second rollback layer;
the older `eisenhower-local-production` model runtime also remains intact. The
rehearsal does not delete the failed runtime, corpus, volumes, images, or
evidence. Only after forward and backward routing checks pass may the new route
be restored. Neither rollback rehearsal authorizes public exposure or retiring
the older runtimes.

## Verification and delivery sequence

Implementation follows focused RED-GREEN-refactor cycles. OIDC tests fail first
in `App` and `oidcSession`; backend and deployment tests fail first for every
new generator, manifest, projection, flag, n8n, and rollback contract.

Verification expands through web unit and integration tests, API client,
FastAPI retrieval/generation tests, Node contracts, n8n contracts, Compose and
deployment tests, builds, typechecks, formatting, lint, production dependency
checks, and the full repository `make verify`. Tests are behavioral evidence,
not proof of historical TDD beyond the recorded new RED/GREEN runs.

The final candidate is promoted through protected feature-to-`dev` and
`dev`-to-`master` pull requests. Each merge requires exact-head checks,
post-merge push CI, ancestry verification, and refreshed remote refs. The
delivery is source-complete only when `origin/master` and `origin/dev` resolve
to the same final green SHA.

All first-party images are rebuilt from that SHA, revision labels are checked,
every final image receives an SBOM and an all-severity Trivy scan, and only then
is the final SHA deployed blue-green to the private loopback/Tailscale runtime.
Authenticated smoke covers OIDC, task lifecycle, retrieval, generated sourced
answer, preview/apply, no-answer, isolation, n8n readiness, memory/MAG disabled
invariants, restart recovery, forward routing, rollback routing, and route
restoration.

## Evidence boundaries at handoff

The handoff reports separately: final code SHA; exact CI runs; manifest and
projection identity/counts; generator and reranker identity; enabled flags and
cohort; private runtime and route; authenticated answer/no-answer evidence;
n8n state; disabled MAG/memory invariants; security scans and SBOMs; preserved
rollback targets; and successful routing rehearsal.

Human assessment of answer usefulness and evidence from genuine user traffic
remain open unless independently observed. Physical camera behavior remains an
open TASK-028 gate. A private deployment is not a public release, public
production, or proof of long-term reliability.
