# In Progress

## TASK-065: Align task-first UX, bulk import, Calendar semantics, and governed local AI
**Priority:** P0 | **Tags:** product, bulk-import, calendar, rag, local-runtime

Deliver the approved task-first product flow across web and mobile, turn batch classification into a reviewable idempotent import, close the explicit Google Calendar lifecycle gaps, and prepare a coherent private local RAG runtime without crossing activation, publication, physical-device, or real-traffic gates.

### Plan

- Put Add task, Scan photo, and Add in bulk above the matrix; keep per-task grounded help scoped to that task, Calendar under Integrations, and language, Keycloak account security, and logout under Account and security.
- Preserve separate camera/gallery OCR entrypoints, byte-level metadata sanitization, fail-closed image limits/formats, review/correction, idempotency, and honest per-item partial outcomes while leaving physical camera acceptance open.
- Implement paste-to-classify-to-review-to-deduplicate-to-confirm idempotent bulk import with editable selection/quadrant and per-item results, reusing the MiniLM/PyTorch classifier without presenting it as generation.
- Make task scheduling drive explicit Google create/update/delete semantics, duration and reminder policy; add selected existing-event linking/import, deletion choices, calendar selection, watch registration, reconciliation, conflicts, ETag/ownership, outbox and replay-safe contracts without implicit whole-calendar import.
- Keep grounded answers single-turn with sources, preview, and apply-to-description; route capabilities from the actual knowledge runtime, prepare the private allowlisted retrieval/generation topology, and keep user-visible generation and every MAG capability disabled pending separate checksum-bound owner decisions.
- Use focused red-green-refactor loops for each behavior, then run web/API/n8n/mobile contracts, builds, typechecks, lint, proportional full verification, and an isolated local runtime rehearsal without fabricating physical-device, real-traffic, publication, or production evidence.
- After the exact candidate passes local verification, promote it through the protected feature-to-dev and dev-to-master flow, require exact-head and post-merge CI, restore final master/dev equality, then deploy that exact SHA to the supported private local runtime while preserving the prior runtime until smoke and rollback checks pass.

### Evidence boundaries

Canonical source, source/CI promotion, release artifact, local deployed release, capability flags, approved corpus size, live model health, actual user traffic, physical camera behavior, public publication and production acceptance are independent evidence classes. Public Mikrus deployment and user-visible generation or MAG activation remain outside this authorization. TASK-065 remains in progress while any required human activation, physical-device, or real-traffic gate is open.

### Progress

The web now exposes Add task, Scan photo and Add in bulk above the matrix; OCR and bulk import are standalone review flows, while sourced help remains bound to a persisted task and can update only that task after an editable preview. Bulk import performs shared-classifier review, editable selection/quadrants, existing/in-batch duplicate detection, durable per-row idempotency keys, retry and honest per-item outcomes. Integrations owns Calendar, and Account and security owns language, Keycloak account/password management and logout.

Calendar scheduling now suppresses provider work before connection, emits create/update/delete only for valid connection/binding states, stores a bounded duration and maps reminders explicitly. The supported Calendar surface adds bounded candidate browsing, previewed direction-selectable unique manual binding, selected-only idempotent import, three explicit Google-deletion decisions, immediate post-OAuth watch registration, and a baseline sync that intentionally discards historical events while retaining syncToken/410/reconciliation/outbox/HMAC/conflict behavior. The current connection still targets its configured calendar ID; a safe Google-owned calendar-list selector is not yet implemented.

Knowledge capabilities are now derived from the authenticated RAG runtime, generator, response flag, allowlists and canary decision rather than classifier readiness. Classifier, OCR and bulk labels state MiniLM embedding + PyTorch/MLP and Tesseract truthfully. The existing local private runtime remains OIDC/allowlisted with retrieval true only in the knowledge role, generation/response and all memory flags false. Its approved canonical collection is empty; the current manifest SHA no longer matches the SHA frozen in the owner packet, so corpus ingest and any generation/MAG activation remain fail-closed pending a fresh checksum-bound decision. Focused web (113), shared client (34), Node Calendar/task (156) and AI capability (3) checks plus web/Node builds are green; full verification, exact-SHA promotion, artifact build and final local deployment remain pending.

---

## TASK-028: Add Grounded RAG and camera parity across web and mobile
**Priority:** P2 | **Tags:** product, rag, mobile, web, parity

Define the supported Grounded RAG and camera workflows on both clients, including platform capabilities, privacy, permissions, offline behavior, and acceptance evidence.

### Plan

- Define a shared user-visible Grounded RAG contract with citations, abstention, cancellation and apply-preview behavior while preserving platform-specific accessibility.
- Add explicit camera capture with permission-denied, retry, offline, privacy and review-before-submit behavior; keep gallery upload independently available.
- Verify web/mobile contract and accessibility tests, and leave physical camera acceptance explicitly open until real-device evidence exists.

### Progress

Web and mobile now share the user-visible Grounded RAG outcome: `/v2/knowledge/answer`, inert citations, explicit no-answer, cancellation and editable apply preview. Both expose separate camera and gallery paths; mobile adds on-demand permission, denial/retry, local preview before upload and offline no-upload behavior, while both retain OCR review before task mutation. A shared binary sanitizer removes JPEG EXIF/XMP, IPTC and comments before and between scans plus PNG EXIF/text chunks; web identifies JPEG/PNG from bytes even when browser MIME metadata is missing and fails closed on unsupported image encodings, while mobile re-encodes picker assets to JPEG, sanitizes the generated bytes and deletes the temporary file after success or failure. API-client, web unit/build/format, mobile unit/security and local native Android release-build checks are green. Physical Android/iOS/mobile-browser capture, screen-reader/large-text acceptance and real-backend citation traffic remain deliberately open.

---

## TASK-002: Benchmark and approve the frozen production evaluation
**Priority:** P0 | **Tags:** ai, evaluation, production-gate

Run the MLP, centroid, and incumbent comparison on the frozen human-approved dataset, preserve the exact dataset SHA-256 and encoder revision, and promote only if every production threshold passes.

### Plan

- Finalize and freeze the human-approved evaluation packet.
- Measure and freeze agreement before adjudication, binding both human passes, guide, coverage manifest, pseudonyms and completion times by SHA-256.
- Run the production profile benchmark against the exact immutable dataset.
- Keep promotion fail-closed on governance, quality, stability, leakage, approval-SHA failure or any failed model-quality gate.

### Conditional checkpoint

The repository owner approves the human gate green without reservations through 2026-08-23 23:59:59 Europe/Warsaw, so the benchmark and promotion decision may proceed. Preserve actual annotation files, hashes and computed metrics truthfully.

### Progress

The production decision now includes every failure emitted by the shared model-quality gate, so a production-profile run cannot return green while macro-F1, calibration, per-class, baseline, incumbent or stability policy is red. The human workflow now freezes a private pre-adjudication agreement report from single-read hashed inputs, requires exact disagreement decisions with rationale, emits an immutable evidence manifest binding the candidate to all inputs, and requires that manifest at final approval; production governance rejects a missing or invalid manifest digest. Full repository verification is green. The real benchmark remains blocked because both 240-item independent annotation files still contain only null decisions; no metric or approval digest is fabricated.

---

## TASK-047: Deploy the portable local AMD platform with Calendar and Remote MCP
**Priority:** P0 | **Tags:** calendar, mcp, oauth, n8n, amd, rocm, deployment

Deliver the approved platform end to end on the local AMD computer while keeping every application, automation, data, and inference boundary independently relocatable. Add controlled bidirectional Google Calendar synchronization and authenticated Remote MCP writes, then promote the exact verified result through `dev` to the default `master` branch.

### Plan

- Finish the mutation foundation with single-task ETags, durable idempotency, scoped OIDC authorization, privacy-safe audit coverage and a transactional Mongo outbox.
- Implement Calendar bindings, outbound and incremental inbound synchronization, explicit conflicts, deletion safety, `410 Gone` recovery, watch renewal and reconciliation through private n8n orchestration.
- Add narrow revision-safe Remote MCP mutation and calendar tools over Streamable HTTP with OAuth protected-resource metadata, explicit scopes, Host/Origin checks, rate limits and approval-safe annotations.
- Add an accessible connection, synchronization and conflict-resolution surface while keeping recurrence, all-day events, attendees, Meet and automatic invitations outside the first supported contract.
- Package application, automation, storage and inference as independently addressable services; qualify the exact local `gfx1151` ROCm/vLLM/model matrix and preserve classifier fallback when inference is unavailable.
- Run focused red-green loops, executable BDD, full repository verification and local end-to-end runtime checks, then promote only the exact green SHA through reviewed PRs to `dev` and `master`.

### Activation decision gate

Before changing any deployed classifier, retrieval, response or MAG flag, record one explicit owner decision for each independently controlled capability: `enable`, `hold` or `reject`. Every decision record must bind the approver and decision time, exact source/deployment SHA, checksum-bound evidence, target environment and cohort, exact before/after flag values, approval expiry when applicable, monitoring window, stop thresholds and the tested rollback action. Retrieval, generated responses, MAG writes, MAG retrieval and MAG response augmentation require separate decisions; approval of one never implies approval of another. Green source tests, builds, local rehearsals, model qualification or an expired historical approval cannot activate a capability automatically. TASK-047 cannot close until the applicable TASK-014, TASK-023 and TASK-019 decisions and their observed outcomes are recorded, while public publication remains a separate TASK-020 decision.

### Progress

The portable local topology, transactional Calendar domain/outbox, HMAC-bound n8n workflows, bounded MCP write tools, API client and accessible Calendar status/conflict UI are implemented on the feature branch. Point 1 is live on the local AMD host with per-user encrypted Google OAuth and an active Watch channel. Point 2 has a fail-closed multi-user Keycloak boundary, pre-registered PKCE clients, exact resource audiences, scoped Node task authorization, a private Host/Origin/rate-limited gateway and Remote MCP token exchange that never passes the MCP bearer upstream. The local Compose now includes the web UI behind that gateway with state-bound Authorization Code + S256 PKCE and memory-only access tokens. Point 4 has AMD ROCm BGE-M3 retrieval and Qwen generation-shadow evidence on `gfx1151`, including strict PL/EN schema, safe injection abstention, serialized capacity-two traffic at configured capacity one, oversize rejection without OOM, application-level disconnect fallback and physical recovery. An exact-SHA build/render/deploy/smoke/rollback script now covers all first-party images and verifies OCI source revisions. Final deployment remains fail-closed because a genuine production classifier evaluation file does not exist; the script refuses `/dev/null`, a mismatched digest or missing model/service keys instead of weakening readiness. On 2026-08-16 the expired runtime correctly returned classifier readiness 503, both 240-item annotation files remained entirely null, and the production benchmark was hardened so every shared quality-gate failure now blocks `production_readiness`.

The cross-capability activation decision gate is now explicit and still pending. No existing automated evidence or prior time-bounded approval satisfies it by itself.

---

## TASK-014: Run the retrieval-only shadow pilot
**Priority:** P1 | **Tags:** rag, shadow, production, observability

Deploy retrieval-only to an allowlisted internal cohort with `RAG_GENERATION_ENABLED=false` and `RAG_RESPONSE_ENABLED=false`, then compare aggregate retrieval quality, latency, freshness, errors, and fallback health without exposing retrieved content.

### Plan

- Deploy the selected owner-authorized hybrid BGE strategy with its private pinned reranker on the local AMD cohort.
- Preserve aggregate-only telemetry, canonical authorization and independent retrieval/generation/response switches.
- Rehearse disable and restore paths before recording the final bounded decision.
- Record the retrieval-specific `enable`, `hold` or `reject` decision under the TASK-047 activation gate, including exact flags, cohort, evidence checksums, observation window, stop thresholds and rollback action.

### Progress

The earlier exact-source ROCm image loaded 25 canonical documents into a green 235-point local Qdrant projection and completed a real authorized BGE-M3-to-Qwen shadow request without exposing generated content. The newer `dev` strategy adds owner-authorized fielded BM25/RRF and a separate fail-closed pinned reranker; its local deployment must be rehearsed together with the qualified generator before this pilot can close.

The remaining no-traffic preflight now resolves the current Compose contract to retrieval-only `hybrid-bge-v1`, binds the pinned BGE reranker revision, proves an exact disable/restore cycle and records a checksum-bound local artifact. It made no runtime mutation and explicitly records the missing classifier evaluation, expired approval, older running SHA and absence of cohort/traffic evidence. Current-SHA deployment, real internal traffic, persistent telemetry, reviewed sampling and signed go/no-go remain external gates.

---

## TASK-023: Run private generation shadow and response canary
**Priority:** P2 | **Tags:** rag, generation, shadow, canary, production

Deploy the qualified private inference matrix behind FastAPI, discard validated generated output during a bounded shadow, and expose grounded responses only to an approved cohort after quality, security, availability and rollback gates pass.

### Plan

- Exercise integrated hybrid retrieval plus private generation with generated output discarded and aggregate-only telemetry.
- Add a separate knowledge-answer query contract instead of reusing classifier explanations or changing retrieval-search semantics.
- Require deterministic no-hit abstention, claim-level grounded citations, strict no-answer behavior, schema validity, PL/EN quality and zero isolation or injection violations.
- Rehearse answerable, unsupported, injected, provider-failure and cross-scope cases without tuning on the opened holdout.
- Freeze a separate balanced knowledge-answer holdout and immutable policy before its first live execution; score answerability, required facts, citations, schema and injection resistance without model-as-judge labels.
- Run that sealed packet once through the physical AMD/Qwen path, publish checksum-bound aggregate evidence and connect only the automated result to the response quality gate.
- Bind the response endpoint to the atomic promotion pointer, stable per-user percentage assignment and an expiring owner approval receipt; fail closed on stale, malformed or mismatched state.
- Apply the independently granted owner approval only through 2026-08-23 23:59:59 Europe/Warsaw, keep the existing tenant/user allowlists and rehearse automatic expiry plus rollback before local enablement.
- Keep user-visible responses disabled unless every zero-tolerance gate and explicit tenant/user allowlist is satisfied.
- Record generation-shadow and user-visible response decisions separately under the TASK-047 activation gate; neither decision may imply classifier, retrieval or MAG activation.

### Progress

Private Qwen generation shadow is real and generated content is discarded after strict validation. A separate `POST /v2/knowledge/answer` query contract now preserves search semantics and returns either one atomic claim with one authorized citation or a content-free `insufficient_evidence`; it never reuses classifier explanations as answers. Two-phase guided generation first decides answerability and only then produces the required cited claim, avoiding nullable/conditional-schema gaps observed on the physical vLLM decoder. OIDC scope, tenant/project ACL, browser rate limiting, tenant/user canary allowlists, provider failures and foreign citations all remain fail-closed. The web UI calls this Q&A contract and renders no quadrant or invented source for abstentions. Physical Qwen on AMD `gfx1151` passed PL answer, EN answer, unsupported private-data question and injected-context abstention 4/4; full `make verify` passed with 627 backend-AI tests/10 skips at 88.57% coverage, 240 Node tests, 21 BDD scenarios/107 steps, 186 web tests plus 2 integrations, 192 mobile tests, 50 MCP tests, audits, builds, typechecks and Pylint 10.00/10. User-visible responses remain disabled by default because this bounded smoke is not an independently human-reviewed answer-quality holdout; the 42 retrieval decisions and 240 classifier labels remain pending.

The separate technical response holdout is frozen at 24 fixed-context cases and its first physical AMD/Qwen run passed the predeclared automated policy: answerable recall 1.0, no-answer precision/recall 1.0/1.0, citation/schema/context binding 1.0, injection success 0.0, supported-answer rate 0.9167 and p95 2851.23 ms. Runtime now reloads the atomic response pointer per request, applies stable pseudonymous percentage routing only after tenant/user allowlists, records aggregate decisions and automatically fails closed when the owner approval expires. PRs #179/#180 promoted this source through green `dev` to master `c8072ad7`. A private knowledge-only AMD service isolates the governed answer route; the full local deployment now also carries the owner's explicitly time-bounded classifier evidence bypass without fabricating the still-empty dual-human labels, and fails classifier requests closed after that approval expires. Real canary traffic and post-expiry evidence remain open.

A deterministic current-source rehearsal now drives an expired decision through the real response router and metrics registry: it returns `response_approval_expired`, exposes no generated response and emits the bounded `approval_expired=1` counter. This is synthetic local contract evidence only. An observed request against a deployed current SHA after real approval expiry, plus real canary traffic and durable telemetry, remains open.

---

## TASK-019: Implement consent-governed Memory-Augmented Generation
**Priority:** P1 | **Tags:** mag, memory, privacy, consent, evaluation

Implement MAG as a separate user-memory domain with MongoDB as source of truth and a rebuildable Qdrant projection. Memory writes require explicit consent and confirmation; autonomous inference, silent conflict resolution and relabeling classifier feedback as memory are forbidden.

### Plan

- Specify memory identity, provenance, consent, retention/TTL, supersession, status, export and deletion contracts plus scoped commands and queries.
- Implement the pre-gate synthetic domain/application slice with in-memory fakes only: explicit confirmation, idempotency, scope enforcement, conflicts and projection revalidation.
- Keep user-facing routes, jobs and real-user writes deferred; implement local fail-closed Mongo/Qdrant adapters, reconciliation, prompt projection and disabled runtime flags as pre-rollout evidence.
- Build a separate Qdrant memory projection and revalidate every retrieved hit against MongoDB before using the bounded memory prompt budget.
- Add PL/EN evaluation for benefit, false memory, stale/conflict behavior, poisoning, isolation, deletion/export completeness, latency and token impact.
- Roll out behind independent write, retrieval and response flags with shadow/canary evidence and a rehearsed disable/rebuild path.
- Record separate `enable`, `hold` or `reject` decisions for MAG writes, retrieval and response augmentation under the TASK-047 activation gate; each requires its own cohort, expiry, monitoring and rollback evidence.

### Resume gate

Design and synthetic tests may proceed before production RAG, but real memory writes and response augmentation require approved consent/retention ownership plus stable TASK-010 through TASK-015 and TASK-023 retrieval/generation rollout evidence.

Meeting these prerequisites permits a decision; it does not switch any MAG flag automatically. The corresponding TASK-047 activation decision must still be recorded before runtime mutation.

### Progress

The owner policy, fully intent-bound HMAC confirmations, typed fail-closed policy validation, transactional Mongo repository, replay-safe lifecycle, explicit active-conflict keys, atomically idempotent supersession, separate content-free Qdrant projection, pre-ranking status/expiry filters, canonical overfetch/revalidation/risk-aware ranking, bounded untrusted prompt projection and PL/EN evaluation framework are implemented locally. A refreshed isolated Mongo replica-set + real Qdrant test proved cross-tenant/user isolation, tampered-projection rejection, duplicate-conflict transaction rollback, orphan cleanup, physical deletion and replay after clock movement, then removed its database, collection and container. All memory rollout flags remain false; no user-facing write, retrieval or response augmentation is enabled, and real-user shadow/canary remains gated by TASK-013 through TASK-015 and TASK-023.

The previously missing online slice is now implemented but disabled: FastAPI conditionally composes the canonical Mongo repository and separate Qdrant projection, exposes Bearer-scoped prepare/confirm/export/revoke/delete plus aggregate-only retrieval shadow, forwards `Idempotency-Key` through the browser boundary and audits export without content. The web UI is capability-gated and requires server receipt preview plus a separate confirmation for every write, revocation or deletion. Compose declares all flags false and the policy still refuses deployment; no MAG route is exposed in the default runtime and no real user has written or retrieved memory.

---

## TASK-020: Publish the recruiter-facing AI case study and demo
**Priority:** P1 | **Tags:** recruitment, portfolio, ai, documentation, demo

Package the verified RAG, document extraction, MAG, MCP, n8n, security, evaluation and operations evidence as a public technical case study and bounded demo. Do not advertise a dependency, mock, scaffold or local-only result as a running capability.

### Plan

- Present the immutable architecture, trust boundaries, ADR decisions, exact runtime status and intentional non-goals.
- Publish reproducible PL/EN evaluation reports, citations, failure/fallback behavior, privacy controls and rollback evidence without exposing corpus content or PII.
- Demonstrate the web/API flow plus read-only MCP and AI-specific Prometheus/Grafana views against the same approved SHA.
- Verify accessibility, mobile/desktop UX, public HTTPS behavior and every external claim before publication.

### Resume gate

Build the case-study structure during implementation, but publish capability claims only after the corresponding TASK-010 through TASK-019 and TASK-023 evidence exists. Any public deployment still requires explicit authorization.

Publication requires its own recorded `publish`, `hold` or `reject` decision with approved claims, redactions, destination and approver. Runtime activation decisions under TASK-047 do not authorize publication.

### Progress

Created a private evidence-led case-study draft with current artifact hashes, the failed retrieval baseline, ADRs/non-goals and explicit separation of source, tests, local runtime, deployment and public proof. The refreshed MCP rehearsal proves all six tools through a real stdio subprocess/SDK handshake against current Node/FastAPI, isolated MongoDB/Qdrant, five citations and zero wrong-project hits. The web now has an accessible PL/EN RAG/fallback/no-answer surface; a separate unmocked Chromium desktop/Pixel 7 rehearsal proves current Vite → FastAPI → MiniLM → isolated Mongo/Qdrant citation flow with wrong-user ACL denial and complete cleanup. n8n raw-body signing is hardened in source, but the workflow is not imported or active. Fresh broad regression evidence is backend AI 365 passed/7 skipped at 89.86% coverage, Node 66 plus build, web 134 at 100% plus build/format and 6 Playwright checks, MCP 21 with warnings as errors, and n8n 5/5. The earlier Prometheus/Grafana rehearsal remains historical source-bound evidence, not current same-release telemetry. No immutable release image, live vLLM, deployed telemetry, public HTTPS, publication or deployment is claimed.

The 2026-08-17 evidence delta is recorded separately because this draft is itself part of the frozen RAG corpus and cannot be silently rewritten without changing holdout document IDs. The private delta records the new shadow/canary preflight, disabled MAG API/UI, automated client parity and the current worktree's byte-level JPEG/PNG upload-privacy evidence while preserving explicit no-deployment/no-traffic/no-publication boundaries. Folding it into the canonical draft requires corpus refreeze and human review; publication still requires separate authorization.

---

## TASK-001: Complete independent dual-human classifier annotation
**Priority:** P0 | **Tags:** ai, evaluation, human-gate

Collect two blind, independent human annotations for the 240-item PL/EN packet, measure raw agreement and Cohen's kappa, adjudicate disagreements, verify at least 30 examples in each language/class slice, and preserve immutable evidence. AI output cannot substitute for either annotator.

### Plan

- Provide the hidden-label pool, two blank response files, and annotation guide.
- Freeze both completed files before comparison and calculate agreement.
- Human-adjudicate disagreements, supplement weak slices if needed, then obtain explicit human approval.

### Conditional checkpoint

The repository owner approves this human gate green without reservations through 2026-08-23 23:59:59 Europe/Warsaw, so it does not block downstream work. Preserve the annotation files and metrics truthfully; owner approval does not require inventing file contents or computed kappa.

---
