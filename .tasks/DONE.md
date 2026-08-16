# Done

## TASK-059: Resolve new experimental LangChain Dependabot alerts
**Priority:** P0 | **Tags:** security, dependencies, dependabot, langchain

Upgrade the isolated experimental LangChain dependency set to close GHSA-pjwx-r37v-7724 and GHSA-926x-3r5x-gfhw without weakening dependency resolution, production image gates or application security boundaries.

### Plan

- Reproduce both default-branch alerts and add or update the smallest fail-closed check that requires a non-vulnerable resolved `langchain-core` version.
- Resolve the complete experimental LangChain/Qdrant set to the smallest mutually compatible pinned versions, preserving the experiment-only boundary and current Qdrant client contract.
- Run focused resolver and LangChain integration tests, continuous production dependency audits and complete repository verification.
- Promote the exact green source through reviewed PRs to `dev` and `master`, verify the default-branch alert state, post-merge CI and final branch equality without deployment.

### Outcome

Raised only the research-only `langchain-core` pin from 1.2.22 to the jointly patched 1.3.3 while retaining `langchain-qdrant==1.0.0`, `langchain-community==0.3.31` and production `qdrant-client==1.19.0`. Added a fail-closed boundary regression covering both advisory floors. The test first failed on 1.2.22, then 10 focused boundary and adapter integration tests passed against the installed 1.3.3 set, `pip check` reported no broken requirements, and the complete `make verify` gate passed.

Promoted reviewed PRs #241 and #243 through exact-head CI, green post-merge `dev` CI and green master push CI to `7918ebb97cd1721447a960875c6dd31280b1a9a8`. GitHub Dependency Graph then marked Dependabot alerts #167 (`GHSA-926x-3r5x-gfhw`) and #168 (`GHSA-pjwx-r37v-7724`) fixed without dismissal, and the governed sync restored exact `dev`/`master` equality. The experimental dependency remains outside production images; no image was published and no deployment or running environment was changed.

---

## TASK-058: Eliminate all release-image vulnerability findings
**Priority:** P0 | **Tags:** security, dependencies, docker, release-gate

Bring all six first-party production images to a fail-closed zero-finding Trivy result across LOW, MEDIUM, HIGH and CRITICAL severities without suppressions, accepted exceptions or reverting the split runtime roles.

### Plan

- Rebuild and scan the current exact-source six-image matrix, classify every finding by installed origin and fixed-version availability, and freeze executable remediation contracts before implementation.
- Remove unnecessary vulnerable runtime contents and update base images, OS packages and language dependencies to patched compatible versions while preserving boundary, classifier, knowledge, ingest, Node API and web behavior.
- Generate retained per-image Trivy JSON and CycloneDX evidence, verify exact-SHA OCI labels and required Torch/Torchvision role contents, and require zero LOW/MEDIUM/HIGH/CRITICAL findings for all six images.
- Run focused red-green checks and complete repository verification, documenting any measured image/runtime impact without weakening functional, security or provenance controls.
- Promote the exact green source through reviewed PRs to `dev` and `master`, close the task, and verify final branch equality and post-merge CI without publishing or deploying images.

### Outcome

Rebased the four split Python runtimes and Node API on digest-pinned Wolfi stages, installed only role-specific package-managed runtimes and copied role-specific Python dependencies into clean final stages. Preserved the boundary, classifier, knowledge and ingest split, exact revision labels, non-root execution, classifier/ingest OCR support and the governed dependency-source audit without suppressions, broad exceptions or `--ignore-unfixed`.

Built all six production images at implementation SHA `e740485043297b119740252c9b6454f712ff26b2`. Fail-closed Trivy 0.71.1 scans reported zero LOW, MEDIUM, HIGH and CRITICAL findings in every image, and retained six JSON reports plus six complete CycloneDX SBOMs. Role-content checks, physical PDF/DOCX/PPTX/HTML PL/EN and owner-approved OCR extraction, focused deployment/auditor/runtime tests and the complete repository verification passed; measured size and single-sample runtime results were retained without hiding the Node RSS regression.

Promoted reviewed PRs #237 and #238 through a green exact-head feature run, green post-merge `dev` CI and green master-PR CI to master `dff9f2e837be54610bf5d419097396afd5efec6d`. Final master push-CI passed and the governed workflow fast-forwarded `dev` to the same exact commit. No image was published or deployed, and no running or public-production environment was changed.

---

## TASK-057: Gate release publication on complete all-severity image scans
**Priority:** P0 | **Tags:** security, dependencies, docker, release-gate

Prevent publication of any first-party production image until its complete installed contents pass a fail-closed LOW, MEDIUM, HIGH and CRITICAL vulnerability scan and produce retained SBOM evidence.

### Plan

- Add a failing release contract that preserves the current six-role image matrix and requires local builds, all-severity image scans, CycloneDX SBOMs and publication only after every gate passes.
- Adapt the earlier unpromoted gate to the current split runtime without reverting role targets, exact-SHA labels, deployment ordering or existing CI controls.
- Update operational and acceptance documentation to distinguish repository scanning, built-image release evidence, publication and deployment.
- Run focused red-green checks, full repository verification and fresh scans of the current images; preserve red findings rather than weakening the policy.
- Promote the exact green source through reviewed PRs to `dev` and `master`, then verify branch equality and post-merge CI without claiming a release or deployment.

### Outcome

Preserved all six current first-party production targets (`boundary`, `classifier`, `knowledge`, `ingest`, Node API and web) and made release publication depend on local exact-SHA builds, complete installed-image Trivy scans for LOW, MEDIUM, HIGH and CRITICAL findings, per-image CycloneDX evidence and role-aware Torch/Torchvision checks. Image pushes now run only after every build, scan, evidence and SBOM assertion succeeds; unfixed findings are not ignored.

Recorded a real red-green release contract, passed the focused 12-test deployment contract, actionlint and the complete repository verification. Fresh exact-tree image evidence produced all 12 reports: web passed with zero findings, while boundary, classifier, knowledge, ingest and Node were correctly blocked. The red reports were preserved rather than weakening the policy or accepting risk.

Promoted reviewed PRs #233 and #234 through `dev` to exact master `6f39d89fa89041e1998bbaffb9e90a075f114439`; feature, post-merge dev, master-PR and final master CI passed, and the governed fast-forward sync restored exact `dev`/`master` equality. No release workflow, image publication, deployment, running stack change or public-production validation was performed.

---

## TASK-056: Make Calendar and automation a coherent business-only product flow
**Priority:** P0 | **Tags:** product, calendar, n8n, web, reliability, accessibility

Close the verified gaps between the web product, Node/FastAPI contracts and live n8n orchestration. Every ordinary user and business administrator must see only business concepts and actions; provider, model, workflow, queue, token, index and infrastructure controls remain outside the product UI.

### Plan

- Freeze regression contracts for the real n8n 2.4.6 workflow shape, Calendar manual/inbound/outbound behavior, lease recovery, failure acknowledgement and idempotent conflict resolution.
- Make workflow import/activation reproducible and drift-detectable, while keeping n8n, queues, dead letters and provider diagnostics private to operators.
- Add a complete accessible Google Calendar connect, disconnect, sync, progress and conflict flow expressed only in business language.
- Integrate the task-centered assistant behind business capability flags while removing browser administration, training and operator credentials.
- Correct delegated lifecycle filtering and retry-safe AI/OCR task creation, then cover the affected desktop/mobile-width behavior with contract, integration and Playwright tests.
- Run focused red-green loops, broad repository verification and a real imported-n8n runtime rehearsal without deploying or changing public production.

### Outcome

Removed technical administration, provider, model, training and operator credentials from the web and mobile product clients. Public AI capabilities expose only business feature availability; technical endpoints require the separate `ai:operate` scope, and a business administrator without that scope is explicitly denied. Preserved the task-centered assistant merged independently on `dev`, with explicit preview/confirmation for sourced descriptions and priority changes, while capability-gating each business action. Added accessible PL/EN Google Calendar connect, disconnect, bounded progress polling, status refresh, conflict decisions, truthful permanent-failure state and business retry across desktop, 390 px and 320 px.

Hardened Calendar end to end: incremental Google pulls drain bounded pagination, large change sets are applied in safe 250-command batches with one success acknowledgement only after every batch, dead letters are visible without technical details and are transactionally requeued on retry, leases prevent overlapping workers, conflict resolution increments task revisions, and outbox delivery plus binding persistence is atomic. Deterministic n8n reconciliation imports five stable workflow identities, publishes only eligible workflows, removes exact-name duplicates, detects active drift, restores the SQLite database on failed reconciliation and converges to a no-op second pass.

Fresh verification passed after integration with current `dev`, including the complete repository gate, a disposable real n8n 2.4.6 import/publish/drift/reconcile rehearsal and Playwright across desktop, 390 px and 320 px. No deployment, public production change or human usability acceptance was performed.

---

## TASK-055: Preserve a usable product experience without GPU inference
**Priority:** P0 | **Tags:** ux, reliability, ai, gpu, web, mobile, deployment

Make the ordinary task product remain available and self-explanatory when GPU inference or reranking is absent, slow or interrupted. Keep AI optional, preserve the bounded CPU classifier fallback, and prevent unavailable AI dependencies from blocking core web/API startup or leaving users with indefinite, stale or misleading states.

### Plan

- Add regression contracts for independent core startup, a supported CPU/no-GPU topology, bounded AI HTTP requests, cancellation, recovery and stale-result removal.
- Decouple core task API/web readiness from optional knowledge and GPU services while keeping AI security, CORS, Bearer authorization and fail-closed grounding unchanged.
- Add shared timeout/error semantics plus accessible web and mobile capability, progress, retry and manual-recovery UX without exposing provider or infrastructure details.
- Rehearse inference and reranker absence against a real local CPU/no-GPU runtime, then restore the existing stack and verify its exact state separately.
- Run focused red-green loops, browser E2E, Compose contracts, broad repository verification and documentation checks; distinguish source/tests, local runtime, deployment and public acceptance.

### Outcome

Made core task readiness independent of optional AI on Node and Mikrus, retained the approved CPU classifier fallback, and added the exact-SHA `deploy-access-core` profile for Mongo, CPU classifier, AI boundary, API, Keycloak, web, MCP and access gateway without Qdrant, knowledge/ingest, vLLM, reranking, n8n or Calendar. The shared client now bounds and cancels AI HTTP requests with stable business-safe errors; web and mobile capability-gate optional tools, clear stale results, ignore late responses and provide accessible retry/manual-quadrant recovery without exposing provider details. Existing bearer/OIDC, CORS/origin, audit, redirect, allowlist and grounded-response fail-closed controls remain in place.

Fresh repository verification passed 794 backend-AI tests with 12 opt-in skips at 87.95% coverage, 246 Node tests at 100%, 21 BDD scenarios/107 steps, 211 web tests at 100% plus two integrations, 198 mobile tests, 50 MCP tests, dependency audits, builds, typechecks and Pylint 10.00/10. Browser E2E passed the no-AI manual task flow and Axe scan at 1440, 390 and 320 px. A disposable loopback boundary used no CUDA/ROCm/torch mappings, reached liveness at about 56 MiB RSS, exposed exact-SHA metrics, and returned bounded 503 readiness/capability responses with both private upstreams absent; the current access-core Compose contract also rendered successfully from isolated placeholder inputs.

The pre-existing 15-container local stack was not restarted or modified and still includes GPU roles; its older operator `.env` needs the new explicit boundary/classifier limits before a future access-core rollout. No image publication, deployment or public/physical acceptance was performed.

---

## TASK-054: Integrate grounded AI into the task workflow
**Priority:** P1 | **Tags:** web, ux, ai, rag, accessibility

Turn the existing grounded-answer capability into a clear task-centered workflow for new and existing tasks without allowing generated content to mutate task data silently.

### Plan

- Add failing behavior tests for editable questions, existing-task entry, honest result states, explicit apply confirmation and separation of administration from user AI tools.
- Replace the five-purpose modal hierarchy with a restrained task assistant surface that keeps decision help and grounded answers contextual while moving administration to its dedicated entry.
- Let users apply a grounded answer to a task description and apply an independently classified quadrant only through explicit preview and confirmation, preserving revisions and draft/error recovery.
- Update PL/EN utility copy and browser acceptance coverage for desktop/mobile, keyboard, accessibility, authorization and fail-closed HTTP behavior.
- Run focused red/green loops, web unit/integration/build/format checks, Playwright/Axe and broader repository verification proportional to the final change.

### Outcome

Replaced the five-purpose AI modal with a task-centered side sheet available from both a new-task draft and owned existing tasks. It combines an independently requested quadrant suggestion with an editable grounded question, honest no-answer handling, visible citations and explicit preview/confirmation before applying either a description or priority change. Draft use remains local until ordinary task creation, existing-task updates preserve the normal API/revision path and failed writes keep the proposed change visible; delegated tasks expose no mutating assistant action.

Moved model administration into its own lazy-loaded dialog with the separate administrator credential gate, retained OCR and batch review as secondary utilities, and updated PL/EN task-first copy. The description field now preserves multiline sourced content. Browser authorization behavior remains unchanged: the existing memory-only Bearer client and fail-closed API/gateway controls are reused, with no new credential storage or messaging/job path.

Implemented with recorded red-green loops. Fresh verification passed 196 web unit tests at 100% statement/branch/function/line coverage, 2 web integration tests, the production web build, six grounded-answer Playwright/Axe scenarios across desktop, 390 px and 320 px, and six board/administration accessibility scenarios across the same viewports. The mobile run first exposed an off-viewport action bug; the full-height scroll container fix passed the repeated narrow-viewport scenarios. No push, PR, deployment, public-production validation or human usability acceptance was performed.
---

## TASK-053: Optimize MongoDB, SQLite and governed document extraction
**Priority:** P0 | **Tags:** mongodb, sqlite, docling, unstructured, performance, reliability

Repair the local asynchronous ingestion path and make the MongoDB, SQLite and Docling/Unstructured runtime bounded, observable and benchmarked without weakening canonical data, audit, idempotency or fail-closed extraction contracts.

### Plan

- Make the API producer and RAG worker share one durable SQLite queue and prove the Compose contract plus enqueue-to-claim behavior.
- Add bounded SQLite retention and query-aligned indexes/WAL settings while preserving audit durability, replay protection, leases and single-site ownership.
- Align MongoDB indexes, pool/timeouts and container resource bounds with observed query shapes; add explain-based and capacity verification.
- Compose governed Docling/Unstructured extraction into the asynchronous worker behind the existing project port, reuse safe parser state and execute parsing in an isolated process with hard wall/RAM limits.
- Add extraction, queue and database metrics plus reproducible cold/warm, concurrency and growth benchmarks with explicit local-only evidence boundaries.
- Run focused red-green loops, broad repository verification, Compose validation and an isolated local runtime rehearsal before documenting the result.

### Outcome

Repaired the split SQLite queue by mounting one durable volume into producer and worker, added WAL/FULL durability, query-aligned claim/cleanup indexes, bounded retention with compact idempotency receipts, stale-heartbeat cleanup and bounded per-job-type metrics. Added strict signed `rag.extract_document` producer/worker contracts and composed manifest-governed Docling plus controlled Unstructured fallback into a reusable spawned child with enforced wall time, monitored RSS kill, a calibrated outer ingest cgroup bound, converter reuse, quality gates and source spans. Bounded Mongo pools/timeouts, aligned task/calendar/RAG/memory indexes, stored memory expirations as BSON dates for TTL, and set explicit 0.25 GiB WiredTiger/1 GiB container defaults. Local evidence includes a shared-queue producer-to-worker run, Mongo `IXSCAN` without blocking sort, 50k-row SQLite smoke, 11-case cold/warm extraction smoke, real reused-child extraction and an over-cap kill. Full repository gates passed after integration with current `dev`; no deployment, production traffic or representative private-document acceptance was performed.

---

## TASK-051: Promote the runtime-footprint work through green dev and master
**Priority:** P0 | **Tags:** release, ci, runtime, rag, promotion

Integrate every unpublished commit from `codex/runtime-footprint-20260815` with the current remote development
line, extend the owner's active conditional checkpoints consistently through 2026-08-23 23:59:59
Europe/Warsaw, and promote the exact verified source through the required PR-to-dev and dev-to-master workflow
without deploying or changing production runtime state.

### Plan

- Reconcile the current `origin/dev`/`origin/master` ancestry and independently merged LlamaIndex work without
  stash, history rewriting, contract regression or loss of either line's evidence.
- Extend only active conditional checkpoints; preserve historical timestamps, consumed approvals and immutable
  benchmark evidence.
- Run the full local release gate and inspect the final security, HTTP/browser, async jobs/outbox, CQRS,
  ports-and-adapters and TDD/DDD/BDD boundaries.
- Push the feature branch, merge a green exact-head PR to `dev`, then merge a green dev-only PR to `master` and
  verify post-merge CI for the exact remote SHA; do not deploy or modify production.

### Outcome

Reconciled the role-split runtime with the independently completed LlamaIndex migration, extended only active
conditional checkpoints through 2026-08-23 23:59:59 Europe/Warsaw, and kept vLLM private for response/reranking
while the knowledge role uses its dedicated pinned PyTorch/ROCm runtime. Full local verification, five strict
Compose renders, exact-SHA builds of all four role images, CycloneDX SBOMs and all-severity Trivy scans passed;
the scan feed reported zero findings with an available fixed version.

Promoted exact head `b7baab89721a673ea397a8af42c35b43edd48ff8` through green PR #209 to dev merge
`3bf3e883fcb5c0efd46f7c23e0d031450a2fa534`, verified its push CI, then promoted dev-only PR #210 to master
`384d40bcde95f77a55ea03897da9ddab10f03b64` and verified exact-SHA push CI, Dependency Graph and automatic
master-to-dev synchronization. Release and deployment remained manual and were not run; production state and
the dirty primary checkout were not changed.

---

## TASK-052: Migrate RAG mechanics to LlamaIndex and isolate the heavy knowledge runtime
**Priority:** P1 | **Tags:** rag, llamaindex, migration, knowledge-service, mikrus

Replace the long-term custom RAG mechanics incrementally with a minimal pinned LlamaIndex engine behind Eisenhower-owned application ports, while preserving MongoDB truth, authorization, canonical revalidation, stable transport contracts and a reversible rollout. Keep the small Mikrus profile limited to the lightweight web/API boundary and place embeddings, retrieval/reranking, ingest/OCR and generation in a private knowledge service on a measured stronger host.

### Plan

- Make the LlamaIndex retrieval and ingestion composition independently startable without constructing the replaced legacy Qdrant/chunking path.
- Route ordinary ingest, replay, tombstone, reconcile and reindex through the versioned LlamaIndex projection while preserving Mongo ordering, idempotency and canonical fail-closed revalidation.
- Replace chunk-ID overlap telemetry with frozen-corpus relevance, citation/no-answer, isolation, stale/tombstone and latency evidence; keep aggregate-only shadow observations.
- Implement a guarded local alias cutover and physical-collection rollback rehearsal, with the previous collection retained and exact-current checks.
- Remove only the superseded legacy mechanics after candidate-only, parity and rollback gates pass; retain Eisenhower-owned domain policy, DTOs, ports, auth, audit and fallback.
- Fix and verify the lightweight Mikrus boundary contract, then run focused red-green, broad tests/lint/audits, Docker/Compose and bounded local runtime evidence without claiming deployment or production.

### Outcome

Cut ordinary retrieval, ingest, replay, tombstone, reconcile and reindex over to exact-pinned LlamaIndex `IngestionPipeline`, cache and Qdrant projection behind Eisenhower ports, selected the shared `llama-sentence-256-32-v1` node identity, and removed the superseded retriever, ingestion adapter, deterministic chunker and shadow router. Mongo remains canonical; tenant/project/ACL revalidation, `source_sequence`, checksum/version, stale/conflict rejection, tombstones, citations, fallback, auth, audit and stable HTTP/MCP/job DTOs remain Eisenhower-owned. Added fail-closed alias preflight/apply/rollback tooling with mandatory durable attempt/result audit and compensation on result-audit failure, and blocked candidate backfill after activation; disposable Qdrant 1.18.2 served the candidate through the alias and served retained legacy data again after rollback.

The selected 36-case unapproved local report recorded hybrid Recall@k 0.9107, MRR 0.6577, citation correctness/recall and no-answer accuracy 1.0, freshness 1.0, zero stale/forbidden/isolation hits and p95 54.00 ms. This improves the historical local incumbent but does not meet the proposed unapproved MRR 0.8 threshold and is not human/holdout acceptance. Fresh verification passed 657 backend tests with 12 opt-in skips, Pylint 10.00/10, 240 Node tests plus build, 50 MCP tests, 25 deployment-profile tests, actionlint, Compose rendering, Python/Node/web/mobile dependency audits, and two live Qdrant tests. Final Trivy scans found zero fixable HIGH/CRITICAL findings in both built images.

The local boundary image is 51,145,114 bytes, reached liveness in 478 ms at 41.27 MiB observed RSS, failed readiness with HTTP 503 when its private upstream was absent, and contains none of torch, torchvision, Docling, Unstructured, ONNX, Tesseract or LlamaIndex. The final private knowledge image is 935,476,896 bytes; isolated LlamaIndex engine initialization took 1.07 s and 141.45 MiB peak RSS on this 109.7 GiB development host. These measurements do not size Mikrus or production. No push, PR, merge, persistent alias change, deployment, Mikrus modification or public production promotion was performed.

---

## TASK-050: Improve single-stage retrieval quality without consuming sealed validation
**Priority:** P2 | **Tags:** ai, rag, retrieval, quality, evaluation

Improve the no-reranker candidate on calibration/train-dev evidence without introducing another cross-encoder or
ColBERT service, weakening zero-tolerance safety, tuning on consumed holdouts, or changing the selected runtime
before every predeclared quality gate passes.

### Plan

- Characterize TASK-049 failures by language and category using only calibration evidence, keeping the validation
  seed sealed and guarding all earlier holdouts against overlap.
- Add the smallest project-owned confidence or fusion improvement behind the existing Retriever/evaluation
  boundary, starting with a failing behavior test and preserving ACL, canonical Mongo and rebuildable Qdrant.
- Run focused and relevant backend tests, Compose contracts and static checks; execute fresh physical calibration
  only if the local candidate is eligible, then either retain the reranker or proceed through the sealed gate.
- Record the measured quality/resource tradeoff and rollback decision without promotion, deployment or production
  changes.

### Outcome

Added an unselected post-fusion confidence and structured-identifier evidence candidate after proving the old
dense/BM25 threshold scales were incomparable. Development improved to Recall@5 0.9688, MRR 0.9297 and p95
120.84 ms, but the independently seeded physical qualification failed at 0.8594/0.8594, no-answer 0.8942 and
134.77 ms p95, with PL Recall@5 only 0.75. Security/isolation stayed green, the original validation remained
sealed and `hybrid-bge-v1` plus its private reranker remains selected. Backend AI passed 745/11 skipped at
88.03%, Compose contracts 24/24 and four renders passed, and the 772-component selected image had zero fixed
LOW/MEDIUM/HIGH/CRITICAL findings. No push, merge, deployment or production change occurred. Full evidence is
in `docs/ai-rebuild/retrieval-task050.md`.

---

## TASK-049: Qualify retrieval without a separate reranker
**Priority:** P1 | **Tags:** ai, rag, retrieval, bge-m3, qdrant, performance

Raise multilingual retrieval quality enough to remove the separately served cross-encoder from the selected
response topology, while preserving ACL, canonical Mongo/Qdrant projection, sealed evaluation, rollback and
all public contracts. Evaluate BGE-M3 dense retrieval first, add lightweight score-aware fusion when needed,
and consider dense+sparse BGE-M3 only if the simpler candidates miss the predeclared quality gate.

### Plan

- Freeze a new PL/EN calibration/validation contract without tuning on consumed holdouts; predeclare quality,
  isolation, latency and resource gates.
- Characterize BGE-M3 dense and weighted-RRF, then add score-aware fusion behind the existing Retriever port.
- Add a versioned native BGE-M3 sparse projection only if simpler candidates miss the calibration gate.
- Select no-reranker only after sealed validation; otherwise retain the incumbent and verified rollback.

### Outcome

Added project-owned DBSF score fusion and a minimal hash-pinned native BGE-M3 sparse head with a separate named
Qdrant projection, without adding FlagEmbedding's training stack or changing HTTP/MCP/jobs contracts. Fresh
physical gfx1151 calibration on the selected dedicated PyTorch/ROCm image kept every ACL/stale/isolation safety
metric green, but the best score-fusion candidate reached only Recall@5 0.8594, MRR 0.8516 and no-answer 0.6042;
dense+sparse also regressed answerable ranking versus dense and no zero-false-positive gate reached 0.90 recall.
The validation seed therefore remained sealed and `hybrid-bge-v1` plus its existing private reranker remains the
selected strategy. Backend AI 730/11 skipped at 87.96%, 24 Compose contracts, Pylint 10.00/10 and a fresh
772-component/zero-fixed-finding image scan passed. No push, merge, deployment, production or public endpoint
change occurred. Full evidence is in `docs/ai-rebuild/retrieval-task049.md`.

---

## TASK-048: Split and bound the AI runtime by operational role
**Priority:** P1 | **Tags:** ai, runtime, docker, rocm, retrieval, reliability

Reduce the backend AI footprint without changing public contracts: separate lightweight online boundaries, classification, knowledge retrieval/response and offline ingest dependencies; require an approved classifier artifact; make heavy runtime profiles explicit; and add measured resource, queue and vLLM lifecycle controls with rollback.

### Plan

- Characterize current images, dependencies, startup training, Compose actions, private HTTP/auth, jobs and retrieval quality gates before changing behavior.
- Split role-specific dependency sets and image targets while keeping framework types behind project-owned ports and keeping Mongo canonical with Qdrant rebuildable.
- Require an approved hash-verified classifier artifact at production startup and move training to an explicit offline command.
- Add explicit core, retrieval, response and full profiles plus private authorized vLLM sleep/wake orchestration with bounded timeouts, readiness, cold-wake and fallback.
- Add measured CPU/RAM/PID/thread/worker/queue limits, deterministic model/cache handling and benchmark tooling for latency, resources, failures and frozen retrieval quality.
- Run test-first focused and broad verification, Compose rendering, image/SBOM/security checks and available local measurements; report hardware/deployment/production gaps separately.

### Outcome

Split the AI runtime into a 248 MB HTTP/auth/audit boundary, fail-closed offline-artifact classifier,
dedicated knowledge and hash-verified ingest roles; made core the default and retrieval/response/full explicit.
Selected the dedicated pinned PyTorch/ROCm knowledge image and official vLLM 0.26 response image after physical
gfx1151, exact-image SBOM, all-severity scan/VEX and bounded failure measurements. Added measured response
CPU/RAM/PID/thread limits, capacity-128 jobs, private authorized mutex-protected stop/wake with bounded probes
and partial cleanup. The one-shot frozen holdout rejected the no-reranker simplification under the declared
quality policy without fabricating human decisions. A local response-only rollback switched exact v0.26 to
retained v0.20 and back, preserving Bearer/readiness/limits with zero OOM/restarts. Backend AI 700/11 skipped,
local contracts 24/24, four Compose renders, shell/diff checks and independent security review are green. The
detailed before/after evidence and remaining production/cold-storage risks are in
`docs/ai-rebuild/runtime-footprint-task048.md`. No push, merge, branch deployment, production change or public
endpoint occurred.
---

## TASK-045: Resolve default-branch Dependabot alerts and promote green dev
**Priority:** P0 | **Tags:** security, dependencies, dependabot, release-gate

Resolve the seven default-branch dependency alerts without bypassing the repository's dev-first branch policy, then promote the verified dependency changes through a fully green pull request to `dev`.

### Plan

- Reproduce the seven-alert security baseline and map each advisory to its manifest, patched version, dependency path and existing mitigation.
- Apply the smallest compatible pytest and LangChain security upgrades on top of current `origin/dev`, preserving the tested Metro parser replacement for the unpatched transitive `image-size` advisories.
- Run focused dependency, experimental-integration and mobile security checks, then the complete repository verification required for a dependency/lockfile change.
- Open a PR to `dev`, require every exact-head check to pass, merge it, and verify the remote merge SHA plus post-merge `dev` CI without touching `master`, deployment or production.

### Outcome

Upgraded both affected pytest manifests to patched `9.0.3` and the isolated LangChain experiment to the smallest compatible `langchain-core==1.2.22` plus `langchain-qdrant==1.0.0` stack, closing all five Python advisories once the default branch is promoted. Added a continuous fail-closed resolver check after proving Dependabot's original core-only update was incompatible. Current `dev` already replaces the unpatched transitive Metro `image-size` parser with a tested local adapter, so all seven findings are fixed or mitigated on `dev` without dismissing valid default-branch alerts. Focused LangChain tests passed 4/4, mobile security 5/5 with zero production audit findings, full local `make verify` passed, PR #167 passed every exact-head check and merged as `cdae711fa98be37f64a78ede93cc516fa51e5dab`; post-merge CI run `31589328464` passed all jobs on that exact SHA. `master`, default-branch alert state, deployment and production were not changed.

---

## TASK-046: Rebuild the web UX for nontechnical users and administrators
**Priority:** P0 | **Tags:** web, ux, accessibility, auth, admin

Make the web application self-explanatory for nontechnical users and administrators while preserving static Bearer authentication, ACL, optimistic concurrency, fail-closed AI controls and existing quality gates.

### Plan

- Replace the technical hero and ambiguous status copy with a task-first PL/EN information architecture, honest local connection/sync states and an independent Administration entry point.
- Improve access-code guidance and errors without persisting secrets, add editable task title/description with revision conflicts and draft preservation, and keep destructive actions explicitly confirmed.
- Rework administration with durable labels, plain-language impact guidance, freshness/pending/error states and guarded high-impact operations without weakening role checks or fail-closed behavior.
- Verify semantic keyboard/mobile behavior, dynamic document language, reduced motion, Axe, unit/integration/Playwright and bounded stakeholder-readable Cucumber scenarios, then update user/admin guidance and security/methodology conclusions.

### Outcome

Replaced the technical landing page with a task-first PL/EN experience, in-memory access-code guidance, honest local sync/offline states, keyboard-safe create/edit/classify/delete flows and an independent Administration entry with guarded high-impact AI actions. Preserved Bearer/ACL/origin/revision/fail-closed contracts, added create idempotency and correct 401/403 handling, expanded bounded Cucumber scenarios and Playwright/Axe coverage at desktop, 390 px and 320 px, and documented both personas. Removed the temporary mobile audit exception and both Trivy ignores by replacing the vulnerable Metro-only image parser with a tested local adapter; clean install audit, Android export, full `make verify` and 18/18 Playwright passed locally. No CI, merge, deployment, production or human usability validation was performed.

---

## TASK-042: Add a durable privacy-safe security audit log
**Priority:** P0 | **Tags:** security, audit, operations, privacy

Persist append-only, integrity-verifiable audit events for sensitive Eisenhower operations without retaining prompts, task text, document content, tokens, MCP arguments, private identifiers, or other user data.

### Plan

- Add strict red contracts for durable restart-safe storage, pseudonymous actors/resources, allowlisted metadata, integrity verification, retention and fail-closed writes.
- Audit administrative operations, auth/ACL denials, ingestion/reindex, memory/consent changes, MCP tool use and rollout/rollback decisions at their application boundaries.
- Bind events to service/release/request identity, expose privacy-safe operational metrics, document access/retention, and verify focused plus broader regression gates.
- Keep remote MCP, OIDC multi-user rollout and public RAG gated until their audit-producing paths are covered.

### Outcome

Added fail-closed durable HMAC-chained audit sinks for FastAPI and Node, authenticated head/retention evidence, pseudonymous identities and allowlisted metadata. Sensitive admin, auth/ACL denial, ingest/reindex, memory/consent, local MCP and rollout/rollback paths now emit attempt/result events without content or arguments. The supported Compose candidate carries persistent storage, exact-release metrics and private Prometheus rules; source/configuration and local tests are green, while deployment, retention execution and real alert delivery remain unclaimed.

---

## TASK-027: Add complete, archive, and trash lifecycle states
**Priority:** P2 | **Tags:** product, lifecycle, tasks

Define and implement reversible task completion, archive, trash, restore, and final deletion semantics without conflating the Delete quadrant with physical deletion.

### Plan

- Add explicit `active`, `completed`, `archived` and `trashed` states with revision-safe action transitions and restoration to the pre-trash state.
- Keep list filters explicit, preserve offline/client fields, and allow irreversible deletion only from trash with no automatic retention purge.
- Implement API, shared client, web and mobile behavior with accessibility, conflict and migration-default coverage.
- Extend executable BDD for complete, reopen, archive, trash, restore and final purge; verify broader Node/web/mobile gates.

### Outcome

Implemented revision-safe active/completed/archived/trashed transitions, restoration to the prior state, explicit filters and permanent deletion only from trash across Node, shared API, web and mobile. The Delete matrix quadrant remains a priority label, offline/conflict behavior is preserved, and the live-process web integration now proves create, update, trash and permanent deletion rather than the removed direct-delete path.

---

## TASK-025: Add Schedule due dates and reminders
**Priority:** P2 | **Tags:** product, schedule, reminders

Add an explicit, timezone-safe Schedule contract without pretending that mocked notifications prove physical delivery.

### Plan

- Persist an optional UTC due instant, IANA display timezone and optional UTC reminder instant; reject incomplete or inconsistent schedules and omit recurrence from this bounded first version.
- Expose revision-safe schedule/set/clear behavior through the API and shared client, preserving offline data and lifecycle state.
- Show editable due/reminder information in web and mobile; schedule/cancel Android local notifications with permission-denied and offline behavior covered.
- Verify timezone boundaries, missed-reminder handling, conflicts and executable BDD; record physical Android notification delivery separately.

### Outcome

Implemented optional UTC due/reminder instants with validated IANA display zones, consistency checks and revision-safe set/clear behavior across Node, shared API, web and mobile. Android local reminders use generic content, survive the offline intent flow and handle denied permissions without corrupting task state. Recurrence remains out of scope and physical notification delivery is still a separate Android acceptance fact.

---

## TASK-026: Add Delegate assignee and status workflow
**Priority:** P2 | **Tags:** product, delegate, tasks

Implement an authenticated in-app handoff workflow, not just an assignee label.

### Plan

- Persist a tenant-scoped assignee subject, bounded display label, handoff note and explicit `offered`, `accepted`, `in_progress`, `blocked`, `completed` or `declined` status with timestamps.
- Let owners assign/reassign/cancel while assignees can list delegated work and perform only valid status transitions; keep core task edits owner-only and enforce tenant isolation plus revision checks.
- Expose owned/delegated views and accessible handoff/status actions in shared, web and mobile clients, with offline conflict handling on mobile.
- Treat the delegated-work view as the supported in-app notification channel; do not claim email/push delivery or current static-runtime cross-user reachability.

### Outcome

Implemented tenant-scoped owner handoff, delegated-work listing and the offered/accepted/in-progress/blocked/completed/declined state machine with revision checks and owner-versus-assignee permissions. Shared, web and mobile clients expose separate owned/delegated views with accessible actions and mobile offline conflict handling. Notification is intentionally in-app only; real cross-user OIDC reachability, email and push are not claimed.

---

## TASK-044: Reassess evidence-triggered optional infrastructure without CDN or managed queues
**Priority:** P2 | **Tags:** architecture, measurement, conditional, checkpoint

Keep cache, remote MCP, horizontal scaling and GraphRAG as measured decisions rather than default infrastructure. CDN and managed queues are explicitly out of scope because the product does not need them now; retain the existing SQLite worker queue.

### Plan

- Measure repeated expensive queries before adding result or prefix cache; require scoped keys, invalidation, privacy boundaries and benefit evidence.
- Revisit remote MCP only for a real external ChatGPT/Codex use case and require OAuth resource-server validation, TLS/gateway, Host/Origin validation, limits and durable audit events.
- Retain the current SQLite worker queue and do not add Kafka, RabbitMQ, a service bus or another managed queue under this task.
- Revisit horizontal replicas only after throughput or availability measurements show the current single-host runtime is insufficient.
- Revisit GraphRAG only if representative multi-hop/entity-relation questions remain materially worse after approved hybrid retrieval.
- Do not add or evaluate a CDN or managed queue under this task.

### Outcome

Recorded explicit measurable triggers for cache, remote MCP, horizontal replicas and GraphRAG, with every capability deferred because current evidence does not satisfy its technical trigger. Redis is disabled behind an explicit experimental profile. CDN and managed queues are out, the existing SQLite worker stays, and no Kafka, RabbitMQ or service bus was added.
---

## TASK-041: Clear the master promotion whitespace gate
**Priority:** P0 | **Tags:** release-gate, quality, python

Remove trailing whitespace from the historical object-storage implementation so the complete `master...dev` promotion delta satisfies the production acceptance `git diff --check` gate without changing behavior.

### Plan

- Remove trailing whitespace only from `backend-ai/app/object_storage.py`.
- Prove token and AST equivalence, run focused tests and the full promotion-delta check.
- Promote the isolated cleanup through a green PR to `dev`, then require fresh exact-head checks on the updated `dev` to `master` PR.

### Outcome

Removed 37 trailing-whitespace-only lines from the historical object-storage implementation. The Python AST and token stream remain identical to `origin/dev`, focused object-storage and dependency-audit tests passed 21/21, and the complete `origin/master...candidate` delta now passes `git diff --check`; promotion remains gated on a normal green PR to `dev` and fresh exact-head checks for PR #163.

---

## TASK-040: Stabilize the language switcher accessibility gate
**Priority:** P1 | **Tags:** accessibility, e2e, web, release-gate

Restore the exact-head E2E accessibility gate by giving the active language control durable WCAG contrast and ensuring automated scans observe the settled intro state rather than an in-flight opacity transition.

### Plan

- Replace the threshold-level active language color with a token that has a safe contrast margin on the rendered light background.
- Synchronize Axe scans with the semantic `data-app-intro=ready` application state without sleeps or disabled rules.
- Verify focused web tests and Playwright, then promote the isolated fix through a green PR to `dev` before rebasing the shadow-classifier candidate.

### Outcome

Replaced the threshold-level active language token with `text-blue-800`, made the reduced-motion path always settle a pending intro, and bound reduced-motion explicitly in both Playwright projects before waiting on the semantic intro-ready state for Axe. PR #161 reproduced a 3.47:1 contrast violation across all retries, while the first PR #162 run proved the project-level device settings had overridden the top-level reduced-motion option; both root causes are covered without disabling accessibility rules or adding sleeps.

---

## TASK-039: Build a shadow CI impact classifier
**Priority:** P1 | **Tags:** ci, mlops, classifier, shadow, safety

Build and verify a separate multilabel change-impact classifier that predicts CI job probabilities with explicit unknown/abstain behavior. Keep full CI authoritative in shadow mode and preserve the existing four-class Eisenhower task classifier contract.

### Plan

- Define isolated versioned dataset, feature, model, prediction, evaluation and lineage contracts with fail-closed validation and conservative human-review labels.
- Implement deterministic path/change/dependency features, a rule baseline, a dependency-light multilabel model, temporal/epoch evaluation and counterfactual shadow planning.
- Add red-green tests for dependency, workflow, lockfile, rename, delete, binary and unknown-path epochs plus metrics, calibration, abstention and immutable evidence.
- Document data acquisition, labeling, shadow operation, additive integration, threat/risk boundaries and exact local verification without changing CI workflow, deployment or production.

### Outcome

Added an isolated versioned multilabel CI-impact contract, Git-derived path/change/import features, conservative GitHub history dataset, temporal/epoch evaluation, rule baseline, immutable candidate lineage and a counterfactual shadow CLI without changing the quadrant classifier or CI workflow. The authenticated snapshot contains 19 merged PRs, 868 files, 162 trusted job observations and 209 deliberately unknown labels; training therefore fails closed and no model quality or eligible candidate is claimed. Shadow evaluation independently reruns the canonical planner, binds it to trusted immutable Actions context, sanitizes command-file environment, and falls back to all 11 jobs for missing/mismatched evidence, local context, OOD, drift, low confidence or any error. Focused tests passed 47/47; fresh full `make verify` passed with backend AI 553/6 skipped at 88.65%, Node 113, web 154 plus 2 integration, mobile 136, API client 14, MCP 26, BDD 16 scenarios/63 steps and Pylint 10.00/10. No workflow/ruleset, merge, deployment, `master` or production change occurred.

---

## TASK-038: Add deterministic change-impact CI planning
**Priority:** P1 | **Tags:** ci, reliability, performance, security

Reduce pull-request CI cost with a versioned, fail-closed impact plan while preserving stable required checks and full release-quality coverage for risky or unknown changes.

### Plan

- Add a deterministic merge-base and changed-path planner with rename/delete, manifest, workflow, root, infrastructure and dependency-graph handling plus multi-label reasons and an input digest.
- Keep every required context successful through explicit not-applicable paths, while forcing full CI for `master`, release, schedules, workflows, lockfiles, infrastructure, unknown inputs and planner errors.
- Add focused red-green planner/rules tests, actionlint and missing n8n/MCP/API-client checks; optimize safe setup/cache paths and document measured baseline boundaries.
- Coordinate sync, release, production-acceptance and ruleset contracts, then run fresh local verification and update the existing PR to `dev` without merging or touching production.

### Outcome

Added a versioned, merge-base-driven and fail-closed impact planner with rename/delete handling, dependency propagation, canonical input digests and explicit reasons. Stable required jobs now fail visibly when resolution fails, otherwise report an explicit not-applicable success; security audits and Trivy remain continuous, while full CI is forced for release-risk inputs. Planner/actionlint contracts, n8n/MCP/API-client coverage, caches and coordinated workflow documentation are included. Fresh local `make verify`, focused security/planner checks and the full PR CI run `31544533146` passed on `872ea7463a58dd039124473464cb9016334502ce`; PR #159 remains unmerged.

---

## TASK-037: Harden repository architecture and promote green dev
**Priority:** P1 | **Tags:** architecture, reliability, security, contracts, quality

Resolve the repository-wide architecture audit findings without introducing speculative framework layers, then promote the integrated result through a fully green PR to `dev`.

### Plan

- Make RAG retrieval canonical against MongoDB, close projection-reconciliation gaps, and make opt-in webhook ingestion durable and payload-bound.
- Make mobile task creation retry-safe end to end; harden Node HTTP semantics, trusted-proxy rate limiting, readiness, pagination, configuration, and repository boundaries where they reduce real coupling.
- Harden MCP redirect authorization, validate API-client runtime contracts, centralize shared quadrant semantics, and add the missing contract/typecheck/quality gates to CI.
- Remove web test warnings, correct stale architecture/methodology documentation, and pin release image inputs where an immutable supported digest is available.
- Integrate the independently verified slices, run the complete local quality/runtime gates, open a PR to `dev`, require all checks green, merge it, and verify the remote merge SHA.

### Scope boundaries

- Preserve the existing pragmatic layered architecture; do not add a generic base repository, full CQRS, or an ORM/ODM abstraction without a demonstrated boundary benefit.
- Do not modify `master`, deploy, publish, enable gated RAG/MAG/generation flags, or claim live production evidence.
- Keep independent-human and physical-device gates fail-closed; local and CI evidence do not satisfy them.

### Outcome

Hardened canonical MongoDB/Qdrant retrieval and reconciliation, durable webhook/job ordering, mobile and Node idempotency/HTTP/configuration/readiness contracts, the bounded Mongoose repository seam, SDK/MCP runtime validation, shared contract fixtures, web request behavior, immutable release inputs and architecture/methodology documentation. Cleared the historical Python and workflow lint debt, made Pylint a 10.00/10 gate, and replaced the PyTorch audit blind spot with exact source/version/hash/vulnerability checks while keeping research-only dependencies isolated. Full local `make verify`, six Playwright checks, Compose/nginx/actionlint validation and all PR checks passed. PR #157 merged to `dev` as `73c984066cfd65ffce0a4fc31f041ba7c24eded2`; the full post-merge CI on that exact SHA also passed. `master`, production, runtime feature flags and human/physical gates were unchanged.

---

## TASK-036: Add a fail-closed AI promotion controller
**Priority:** P1 | **Tags:** ai, promotion, shadow, canary, rollback

Implement a reversible controller for independently governed retrieval, generation, response and MAG phases. Require immutable candidates, explicit approvals and green quality/drift evidence before shadow or canary pointer changes, with stable assignment, stop conditions and rollback.

### Plan

- Add red state-machine tests for illegal transitions, missing or stale evidence, phase dependencies, canary assignment and rollback.
- Keep candidate artifacts immutable and write only auditable atomic pointers; never enable a phase merely because another phase starts.
- Provide local dry-run and CI contract checks while leaving production traffic, owner approvals and deployment as explicit resume gates.

### Outcome

Added a locked atomic pointer state machine for independently governed retrieval, generation, response and MAG phases with legal `disabled -> shadow -> canary -> enabled` progression, dependency gates, bounded stable pseudonymous canary assignment, immutable-candidate verification, fresh checksummed green quality evidence and matching approval receipts. Each applied transition preserves a private rollback pointer; dry-run is the CLI default and `--apply` changes only local state, never runtime flags or deployment. TDD evidence: the test first failed on the absent controller; three fixtures then exposed their own invalid shadow percentages without weakening the implementation. Green evidence is 17 promotion/monitoring tests and pylint 10.00/10. No production approval, flag change, traffic assignment or deployment occurred.

---

## TASK-035: Add quality and drift monitoring reports
**Priority:** P1 | **Tags:** ai, monitoring, drift, observability

Produce privacy-safe, checksummed periodic quality and drift reports for classifier, retrieval, generation, response and MAG phases without logging prompts, PII, tokens or private identifiers.

### Plan

- Add red tests for baseline comparison, slice drift, missing evidence, sensitive-label rejection and fail-closed status.
- Reuse aggregate metrics while keeping offline quality reports distinct from runtime SLO telemetry.
- Register reports in the shared lineage manifest and expose only bounded status/metrics needed by promotion decisions.

### Outcome

Added a checksummed aggregate-only quality/drift report for classifier, retrieval, generation, response and MAG. Missing phases, samples, metric drift or slice drift block the report; recursive field validation rejects prompt, token, content, citation, PII and private-identifier keys before serialization. Reports record only counts/deltas and can be registered as monitoring lineage without retaining raw snapshots or collection IDs. TDD evidence: tests first failed on the absent monitoring module and later absent registrar; green evidence is 12 monitoring/metrics tests and pylint 10.00/10. This is offline quality evidence, not deployed telemetry or an invented production SLO.

---

## TASK-034: Automate the LLMOps candidate workflow
**Priority:** P1 | **Tags:** ai, llmops, prompts, evaluation

Build a candidate-only workflow for immutable PromptSpec checksums, schema and token budgets, PL/EN golden, safety and structured-output evaluation, regression comparison and candidate registration. Mock or in-process results must be labelled and must never satisfy a live-model gate.

### Plan

- Add red contracts for prompt/schema/runtime lineage, required PL/EN and safety slices, regression policy and evidence-level separation.
- Reuse the prompt registry, renderer, validators and regression gate to create a deterministic offline candidate command and CI job.
- Keep model/tokenizer/GPU/license selection, live vLLM and champion promotion fail-closed.

### Outcome

Added a candidate-only LLMOps workflow that checksum-validates PL/EN PromptSpecs and token budgets, binds the JSON Schema, golden/adversarial cases and independently frozen mock outputs, then executes schema, citation-safety and regression comparisons without a model. It registers a checksummed `ci_in_process` contract candidate and explicitly records `live_model.executed=false`; this does not satisfy live-model quality. TDD evidence includes fail-closed registrar tests and a regression caused by changing a frozen mock output. Model/GPU/license selection, real live-model evaluation, durable private CI storage and promotion remain open.

---

## TASK-033: Automate the RAGOps candidate workflow
**Priority:** P1 | **Tags:** ai, ragops, ingestion, qdrant, recovery

Compose the approved corpus manifest, governed extraction, canonical MongoDB, versioned Qdrant, reconciliation, evaluation and snapshot/restore primitives into one checksummed candidate workflow. Candidate creation must never promote the live alias automatically.

### Plan

- Add red contracts for immutable lineage, canonical-before-vector ordering, reconciliation, snapshot verification and absence of alias promotion.
- Reuse existing ingestion, collection and evaluation components behind an explicit candidate command and CI-local smoke profile.
- Register reports and recovery evidence while keeping real services, representative review and deployment as explicit external gates.

### Outcome

Added a RAGOps candidate registrar that requires canonical-before-vector ordering, zero reconciliation drift, evaluated retrieval, a checksummed isolated snapshot/restore proof, Mongo/Qdrant runtime identity and an explicitly unpromoted alias. It registers corpus, golden set, encoder, canonical schema, versioned collection receipt, snapshot and report in the shared immutable registry; it cannot switch an alias. A CLI accepts only freshly produced report/snapshot inputs and fails closed rather than rebinding stale evidence. TDD evidence: the focused slice first failed on the missing registrar; green evidence is 30 focused/RAG regression tests with one opt-in live-runtime skip and pylint 10.00/10. Representative TASK-013 review, target runtime and deployment remain external gates.

---

## TASK-032: Automate the MLOps candidate workflow
**Priority:** P1 | **Tags:** ai, mlops, training, evaluation

Build a deterministic candidate-only workflow for data validation, leakage and required slices, multi-seed training, incumbent/baseline comparison, thresholds and checksummed artifact registration. Human-approved production evaluation and promotion remain fail-closed.

### Plan

- Drive the workflow with red contract tests and reuse the existing evaluation, benchmark and atomic model-generation components.
- Separate candidate creation from any current/champion pointer change and record seeds, dataset, encoder, code and report lineage.
- Add a local command and CI job that produces private immutable artifacts without fabricating TASK-001 or TASK-002 evidence.

### Outcome

Composed the existing deterministic grouped-CV, five-seed training, leakage, PL/EN slices, centroid baseline, incumbent and threshold report into a candidate-only registry workflow. It records training/evaluation data, encoder receipt, schema, runtime, Git and report lineage, requires the development gate to pass, preserves a failed human/production gate in the report, and proves the current model pointer is unchanged. CI builds the private registry only in runner-local storage and uploads a checksummed allowlisted public commitment, never full lineage or blobs; durable private CI storage remains an external owner gate. No human annotation, production approval or model promotion was performed.

---

## TASK-031: Add an immutable AI artifact registry and lineage manifest
**Priority:** P1 | **Tags:** ai, mlops, ragops, llmops, lineage

Create one dependency-light, immutable candidate manifest that binds Git SHA, datasets, encoder/model revisions, prompt/schema, corpus/Qdrant state, runtime identity and reports by checksum. Store candidates privately without overwrite or delete semantics and keep promotion pointers separate and reversible.

### Plan

- Add red contract tests for canonical serialization, checksums, complete typed lineage, immutability, conflict rejection and private filesystem storage.
- Implement a project-owned manifest/registry and CLI that can register and verify candidates without introducing MLflow or a new service.
- Integrate the registry contract with later MLOps, RAGOps and LLMOps workflows while keeping promotion outside candidate creation.
- Run focused and broader local verification and record exact artifact boundaries.

### Outcome

Added a strict checksummed `ai-candidate-v1` lineage contract with explicit applicable/not-applicable groups for datasets, model/encoder, prompts, schemas, corpus, Qdrant, runtime and reports. Added a private filesystem registry with content-addressed blobs, `0700` directories, `0600` files, exclusive creation, idempotent identical registration, conflict/tamper detection and no delete or promotion operation, plus a register/verify CLI. No MLflow or persistent service was introduced. TDD evidence: the collected test first failed because `app.artifacts` did not exist; the CLI slice separately failed on the missing CLI module. Green evidence: 5 focused tests and 45 artifact/prompt/model/evaluation tests passed, and pylint rated the new modules 10.00/10.
## TASK-030: Promote executable BDD to green dev
**Priority:** P1 | **Tags:** bdd, delivery, dev, ci

Publish the completed TASK-029 BDD package through a pull request to `dev`, require every repository check to pass, merge only after green CI, and verify the resulting remote `dev` commit. Do not modify `master` or deploy production.

### Plan

- Commit only the intended BDD, documentation, CI, and TaskPlanner changes on a dedicated branch.
- Integrate the latest `origin/dev` without losing or stashing the dirty worktree, then rerun release-level local verification.
- Push the branch, open a detailed PR to `dev`, and wait for all required checks before merging.
- Close the TaskPlanner promotion state through a follow-up PR if necessary and independently verify the final `origin/dev` SHA.

### Outcome

Reconciled the local package with PR #153 without stash or data loss, renumbered the colliding local tasks to TASK-029/TASK-030, and reran the complete local release-quality gate. Green PR #154 passed branch policy, security/Trivy, Node including 15 BDD scenarios/59 steps, frontend unit/integration/Playwright, backend AI, mobile and native Android checks, then merged to `dev` as `0721ca8f2edbeb4216622f315b23d62119cb5d83`. The remote merge SHA was fetched and verified before this follow-up state update. `master` and production were not changed.

---

## TASK-029: Add executable BDD for task behavior
**Priority:** P2 | **Tags:** testing, bdd, cucumber, backend-node

Add a real executable Gherkin workflow for the user-visible task lifecycle without relabeling ordinary Jest tests as BDD.

### Plan

- Preserve the existing seven lifecycle/quadrant scenarios and typed Express/Supertest/Mongo harness.
- Add bounded living scenarios for bearer authentication, trusted browser origins, request validation, and missing-resource behavior.
- Keep unit-level edge cases, experimental AI/RAG, messaging, and physical-device acceptance outside this BDD slice.
- Run focused BDD/backend verification and the complete root release-quality gate, then update the documented evidence boundary.

### Outcome

Added a Node 20/24-compatible Cucumber 12.9 executable acceptance layer with typed TypeScript steps driving the real Express app through Supertest and isolated MongoDB. Fifteen Gherkin scenarios and 59 steps now cover all four canonical quadrants, task movement/deletion, tenant isolation, missing and invalid bearer credentials, trusted and untrusted browser origins, title limits, unexpected-field rejection, and missing-resource behavior. The harness pins and restores auth/OIDC/CORS environment state and passed with deliberately hostile inherited variables. Added `test:bdd` and `make test-bdd`, included BDD in root test/verify and the existing backend CI job, and documented that this is a bounded living-behavior slice rather than repository-wide BDD, DDD, CQRS, hexagonal architecture, or historical TDD evidence. After integrating current `origin/dev`, fresh `make verify` passed production audits, Node 87 tests at 100% plus BDD 15/15, web 150 at 100% plus 2 integration tests, backend AI 419 with 6 opt-in skips at 89.44% coverage, and mobile 115 tests; `actionlint` and YAML parsing also passed.

---

## TASK-024: Harden supported task runtime and client reliability contracts
**Priority:** P0 | **Tags:** production, auth, tasks, web, mobile, reliability

Implemented the safely decidable engineering and functional remediations from the fresh read-only audit without deploying, publishing, weakening gates, or implying multi-user production readiness.

### Plan

- Prove and fix the exact Mikrus static-auth runtime contract and Node AI readiness timeout behavior.
- Preserve failed web drafts and accurate partial import/feedback behavior; split user/admin credentials, add logout, OCR review/consent, destructive confirmations, and accessible interaction contracts.
- Add mobile reconnect/retry, honest sync states, logout, OCR review/consent, destructive confirmations, and regression coverage.
- Enforce owner-scoped OIDC task access, optimistic concurrency, backward-compatible pagination, and a supporting database index.
- Bound or renew experimental job leases, align monitoring with the real topology, and add focused multi-worker/alert coverage.
- Record strict red-green evidence, run focused checks, full `make verify`, Playwright E2E, Compose/runtime smoke, and document architecture/security/methodology conclusions.

### Outcome

Mikrus now renders and boots the supported static single-tenant contract, while Node readiness uses `/health/ready` with a bounded abort timeout. OIDC task reads and writes are owner-scoped inside the tenant; revision ETags, optional `If-Match` conflicts, cursor pagination and the compound owner/sort index preserve legacy clients while updated web/mobile clients use guarded writes. Web and mobile now separate access/admin credentials, retain failed drafts and pending work, expose logout/recredential, provide editable/selected OCR review with independent feedback consent, report partial persistence honestly, localize changed accessibility surfaces, confirm destructive actions and distinguish quadrant Delete from physical deletion. Playwright now includes a WCAG A/AA axe gate on desktop and mobile. Mobile additionally retries on refresh, foreground and network recovery, and exposes explicit conflict resolution against the fresh server revision.

The experimental SQLite worker renews long leases and durable heartbeats, refuses acknowledgement after renewal loss, and has multi-worker coverage. Prometheus now scrapes the real optional inference target and gates inference/worker alerts on configured runtimes; `promtool` validated the config and all 9 rules. Schedule reminders, Delegate workflow, lifecycle states and RAG/camera parity remain separate TASK-025 through TASK-028 product decisions.

TDD evidence was recorded from failing contracts for Compose boot, readiness timeout/unready, owner isolation/concurrency/pagination, web/mobile mutations and OCR, reconnect/conflicts, worker lease/heartbeat and topology-gated alerts, followed by focused green runs. Final local verification: `make verify` passed Node 87/87 at 100% coverage, web 150/150 at 100% plus 2 integration tests, backend AI 415 passed/7 skipped at 89.40%, and mobile 115/115 above every coverage threshold. Playwright passed 6/6 desktop/mobile checks; the exact rendered Mikrus environment passed 19 focused deployment/readiness tests and the Node production config loader; system `pytest 7.4.4` is installed. No deployment, public runtime, physical-device, live inference, n8n/job/webhook production, commit, push or PR evidence is claimed.
---

## TASK-022: Implement a portable private generation boundary
**Priority:** P2 | **Tags:** rag, generation, gpu, portability, security

Implement the locally verifiable vendor-neutral FastAPI-to-`GenerationProvider` boundary for a fixed private OpenAI-compatible inference endpoint without assuming GPU colocation or vendor. Preserve application-owned auth, ACL, retrieval, prompt construction, validation, citations, fallback and all three RAG gates.

### Plan

- Add red contract and failure tests for NVIDIA/CUDA versus AMD/ROCm and local versus remote endpoint invariance, plus unavailable, timeout, 429/5xx, disconnect and invalid structured output.
- Harden the fixed private endpoint, service authentication, secrets, bounded phase timeouts, circuit breaker, health/metrics reporting and safe classifier fallback.
- Separate neutral base configuration from disabled opt-in NVIDIA/CUDA and AMD/ROCm vLLM profiles without publishing the inference port.
- Report CUDA, ROCm, MPS, CPU and other supported runtimes honestly, and document the hardware/runtime/model/quantization matrix plus exact live gates.
- Run focused and full local verification while keeping every live GPU, vLLM, performance, VRAM, OOM and production claim explicitly open.

### Resume gate

Local contracts, configuration, profiles and mock transport verification may proceed now. Enabling generated responses or declaring hardware compatibility remains governed by TASK-015 and TASK-023.

### Outcome

Replaced the application-level vLLM naming/configuration with a vendor-neutral private OpenAI-compatible adapter while keeping the compatibility input, all RAG flags, FastAPI auth/ACL/prompt/validation/citation ownership and classifier fallback. Added explicit private-host allowlisting, service auth, phase timeouts, bounded failure reasons, a concurrency-safe single-probe circuit breaker, optional readiness/Prometheus circuit reporting and honest CUDA/ROCm/XPU/MPS/CPU detection. Removed the NVIDIA FastAPI image and common CUDA settings, then added separate disabled NVIDIA and AMD vLLM profiles with no host port and no default service secret. Documented local/remote topology, the evidence-bound hardware/runtime/model/quantization matrix and exact live gates. TDD evidence: the first focused run failed at collection for the missing neutral provider; the profile contract then failed 2/2 before the files existed. Green evidence: focused Python 102/102, profile 2/2, Node deployment 7/7, both Compose renders, changed Python pylint 10.00/10, and full `make verify` passed Node 66, web 135 plus 2 integration, backend AI 414 with 6 opt-in skips at 89.46% coverage, and mobile 95. No live vLLM, selected model, CUDA/ROCm inference, performance, VRAM, OOM, deployment or production claim is made.

---

## TASK-021: Enforce grounded information-delta responses
**Priority:** P1 | **Tags:** rag, generation, novelty, grounding, evaluation

Add a fail-closed contract that compares generated claims with explicit known state or prior-output facts and distinguishes grounded new information, confirmation, contradiction/update, necessary reminders, and honest no-new-information. A frozen corpus proves only source-relative delta, never current-world freshness.

### Plan

- Add bounded untrusted known-state input and a structured information-delta output without introducing implicit history or autonomous memory writes.
- Validate claim relations, known references, allowed citations, semantic near-duplicates and world-freshness scope deterministically; reject fabricated novelty and invalid deltas.
- Expose validated delta metadata only on the existing guarded RAG response path, while keeping fallback, TASK-013, vLLM and MAG rollout gates unchanged.
- Add PL/EN evaluation metrics and regression tests for paraphrases, repetition, contradictions, updates, necessary reminders, no-new-information and prompt injection.
- Verify source, tests and local in-process reachability separately from live vLLM, deployment and public evidence.

### Resume gate

Local schema, validation and in-process contract tests may proceed independently. Live generation, response canary and MAG augmentation remain blocked by TASK-013 through TASK-015 and their human/deployment gates.

### Outcome

Added checksummed, bounded and explicitly untrusted known-state/previous-output input plus a strict information-delta schema for new information, confirmations, contradictions, updates, necessary reminders, honest no-new-information and frozen-corpus freshness abstention. The application layer now enforces known-reference validity, allowed citations, citation support, semantic repetition and claim deduplication through a versioned similarity port wired to the pinned retrieval MiniLM; prompt text alone is not treated as enforcement. Invalid deltas fail closed to the bounded fallback, current-world requests abstain without generation, model prose is not surfaced for delta responses, and MAG remains a separate consent-governed domain with no implicit history writes. Added PL/EN quality/safety metrics, adversarial tests and a mocked private-vLLM strict-schema transport test. Fresh verification passed 385 backend tests with 7 opt-in runtime skips at 89.28% coverage, changed modules scored pylint 10.00/10, PromptSpec 1.1.0 checksums passed and diff hygiene passed. This proves source, tests and local in-process/mock-HTTP reachability only; the candidate PromptSpec still intentionally lacks an approved model/tokenizer, local MiniLM weights were not fetched, and no live vLLM, deployment, canary or public evidence is claimed. TASK-013 through TASK-015 and MAG rollout gates remain unchanged.

---

## TASK-012: Prove Qdrant isolation, reindex, backup, and rollback
**Priority:** P1 | **Tags:** rag, qdrant, integration, recovery

Run production-like Qdrant integration tests for tenant/project/ACL isolation, tombstones, versioned collections, alias cutover, snapshots, restore, and rollback using the approved corpus contract.

### Plan

- Exercise a real Qdrant service rather than only mocks or in-memory client mode.
- Verify cross-tenant/project denial, stale-content removal, snapshot checksums, isolated restore, and alias rollback.
- Record exact Qdrant version, commands, artifact hashes, timings, and retained previous collection.

### Outcome

Hardened the Qdrant projection so replacement and privacy tombstones physically delete tenant/document points instead of retaining private text and vectors behind a flag, and made projection inspection paginate beyond 10,000 points. Added guarded alias transitions with expected-current and postcondition checks plus snapshot metadata, uploaded restore and cleanup operations. The real loopback Qdrant 1.12.0 rehearsal proved tenant/project/ACL denial, zero stale/tombstoned/orphan points, a 768,512-byte snapshot whose server checksum matched independently downloaded SHA-256 `daa09e4deb7b14fcbbae0fa6e30de8ca60723ff8e7be824cb3a7445959f7af3a`, isolated restore with an identical collection digest, atomic alias cutover, retained previous collection and rollback without resurrecting the propagated tombstone. Snapshot and isolated collections were cleaned up. The live recovery test passed 1/1, the full backend suite passed 299 with 5 opt-in skips at 89.57% coverage, and changed modules scored pylint 10.00/10. This is production-like local-container recovery evidence, not a target-environment or production rehearsal.

---

## TASK-018: Add governed Docling and Unstructured document extraction
**Priority:** P1 | **Tags:** rag, ingestion, docling, unstructured, documents

Implemented Docling as the primary document parser and Unstructured as a bounded fallback behind a project-owned extraction port for the document formats approved in the first RAG corpus. Preserve provenance and fail closed on unapproved, unsafe or ambiguous input.

### Plan

- Define a `DocumentExtractor` contract and source-specific normalized result without leaking framework types into application/domain code.
- Add allowlisted size/media/extension checks, resource budgets and negative fixtures for archives, encrypted/malformed files, embedded content, prompt injection and unsupported formats.
- Preserve headings, lists, tables, page/source spans, checksums, extraction version and OCR provenance for deterministic chunking and deletion/reindex.
- Benchmark Docling primary output and Unstructured fallback on reviewed PL/EN golden documents; record quality, latency, memory, rejection and exact-version evidence.
- Connect only the approved document source to TASK-011's canonical document store, reconciliation and privacy-deletion lifecycle.

### Outcome

Added strict project-owned inspection, policy, extraction and ingestion contracts for approved local PDF/DOCX/PPTX/HTML sources. Docling 2.119.0 uses the immutable `docling-layout-heron-onnx` revision on ONNX Runtime CPU; Unstructured 0.25.2 runs only for the two approved quality/layout reasons, while security, resource and programming failures remain fail-closed. OCR requires a receipt frozen in the corpus manifest and records the exact checksum, PL/EN scope, Tesseract CLI 5.3.4 provenance and human approval ID. The offline benchmark passed 11 runtime cases: five formats through both parsers plus owner-approved image-only PDF OCR, with required text present and exact dependency/model evidence. A real local MongoDB/Qdrant integration passed all six approved fixtures through canonical persistence and projection with zero reconciliation drift. Focused tests passed 49/49, the live integration passed 1/1, the full backend suite passed 298 with 4 opt-in skips at 89.83% coverage, changed modules scored pylint 10.00/10, and dependencies passed `pip check`. This proves local code, tests and local runtime only; deployment and public evidence remain absent.

---

## TASK-011: Complete the canonical RAG ingestion contract
**Priority:** P1 | **Tags:** rag, ingestion, data-integrity

Implemented the approved source connector and canonical document lifecycle with deterministic source-specific normalization, schema/chunking versions, project metadata, reconciliation, reindex, and privacy deletion semantics.

### Plan

- Add red contract tests for normalization, versions, stale updates, deletes, and source boundaries.
- Implement the frozen manifest loader and allowlisted repository/document connector without generic URL fetching.
- Persist canonical documents in MongoDB before vector writes, with monotonic source sequences, tombstones and privacy-safe deletion.
- Implement reconciliation and a real project reindex handler without widening the existing signed job allowlist.
- Verify focused tests, full backend-AI regression, static analysis, manifest integrity and TaskPlanner uniqueness.

### Outcome

- Bound repository reindex to the frozen manifest version/checksum, approved tenant/project and fixed owner identity; added the 19-file frozen snapshot plus six allowlisted incremental TaskPlanner Markdown sources.
- Made MongoDB the canonical version authority before Qdrant projection, with monotonic writes, exact-revision completion, conflict detection, tombstone redaction, pending reconciliation and projection read-back by chunk ID/checksum/content version.
- Added forced full-project rebuild after Qdrant collection loss, fail-closed private Mongo validation/startup ping, exact queue idempotency conflicts and an unchanged four-command job allowlist.
- Verified real local MongoDB 7 and Qdrant 1.12 runtime: 25 canonical documents produced 155 active chunks, forced rebuild completed 25/25 with zero pending and reconciliation reported zero drift; an independent collection-loss integration test also passed.
- Full backend-AI verification passed with 249 tests, 3 opt-in skips and 89.82% coverage; changed application modules scored pylint 10.00/10 and `git diff --check` passed. This is local runtime evidence, not deployment or public evidence.

---

## TASK-010: Approve the first RAG corpus and privacy manifest
**Priority:** P1 | **Tags:** rag, corpus, privacy, human-gate

Choose the first canonical knowledge sources and record ownership, tenant/project ACL derivation, provenance, retention, deletion, PII handling, source connector, and explicit exclusions before any real user content is indexed.

### Plan

- Select the smallest product use case where project context measurably improves prioritization.
- Prepare an exact owner decision packet covering sources, formats, ACL, provenance, PII, retention, deletion, OCR, connector and explicit exclusions.
- Complete the corpus manifest and privacy/retention decisions with the responsible human owners.
- Approve a synthetic-to-real-data transition and keep unapproved sources fail-closed.

### Resume gate

Requires explicit user/data-owner decisions; Codex must not infer consent to index tasks, notes, calendars, chats, email, OCR, or history.

### Outcome

Recorded the repository owner's explicit full-scope approval and froze `eisenhower-corpus-v1`: 19 project documents in the immutable initial snapshot, versioned TaskPlanner sources, and governed PDF/DOCX/PPTX/HTML inputs. Approved Docling primary extraction, deterministic Unstructured fallback, PL/EN OCR with mandatory human review, MongoDB-before-Qdrant persistence, ACL derivation, PII/secret rejection, retention/deletion and explicit exclusions. The parser contract was re-frozen with explicit 500-page, 120-second, 4-GiB peak-memory and 20-character primary-quality limits, an immutable Docling 2.119.0 ONNX CPU layout runtime/model revision, and a checksum-bound owner receipt for the synthetic OCR fixture. After the approved documentation itself changed, the same 19-file allowlist was owner-refrozen on 2026-08-11 rather than bypassing snapshot validation: source snapshot SHA-256 `7d52fdd5f973f62a19f3c67a1afcfbe3d4990d80c75439e550b34f5d6188dd43`, manifest SHA-256 `b022333de73442927099881fdb4e327d7edea0feb1eba9ad809511e9ccec9f5f`. Deployment and publication remain unauthorized.

---

## TASK-017: Record the recruiter-aligned AI delivery plan
**Priority:** P1 | **Tags:** documentation, ai, rag, mag, recruitment

Record the coherent AI portfolio scope selected from the reviewed technology graphics and current czyjesteldorado.pl market signals. Make Docling/Unstructured document extraction and consent-governed MAG explicit delivery commitments, while preserving honest implementation, runtime, and production evidence labels.

### Plan

- Add a recruiter-facing roadmap that distinguishes required capabilities, bounded supporting tools, and explicit non-goals.
- Update the canonical delivery roadmap and TaskPlanner continuation map.
- Create executable follow-up tasks for document extraction, MAG, and the public technical case study.
- Verify links, TaskPlanner uniqueness, Markdown formatting, and the final diff.

### Outcome

Added the recruiter-aligned AI delivery plan, made governed Docling/Unstructured extraction and consent-governed MAG committed P1 scope, and created TASK-018 through TASK-020 for extraction, MAG, and the public case study. Updated the canonical roadmap and index while preserving evidence levels and explicit non-goals. Verified Markdown links, unique TaskPlanner placement and IDs, configuration numbering, and a clean `git diff --check`.

---

## TASK-016: Promote retrieval-first RAG package to green dev
**Priority:** P0 | **Tags:** rag, delivery, dev, ci

Publish the completed retrieval-first RAG package through a pull request to `dev`, require the repository checks to pass, merge only after green CI, and verify the resulting remote `dev` commit. Do not modify `master` or deploy production.

### Plan

- Audit the intended diff and refresh the remote branch relationship.
- Run release-level local verification, commit the scoped changes, push the feature branch, and open a PR to `dev`.
- Resolve only failures caused by this package, merge after green CI, and verify the remote `dev` SHA.

### Outcome

Integrated the package with the latest `origin/dev`, passed the full local `make verify` gate, and merged green PR #148. GitHub checks passed for branch policy, run-mode resolution, Trivy/security lint, backend AI, backend Node, frontend unit/integration/E2E, mobile, and native Android APK. Remote `dev` was independently fetched and verified at merge commit `8a2277be524bed5ceeb8c089b64e6a239f9a2fff`. `master` and production were not changed; real corpus approval, live Qdrant recovery/evaluation, production shadow traffic, vLLM/model/GPU selection, and advanced RAG remain in TASK-010 through TASK-015.

---

## TASK-009: Establish the retrieval-first RAG delivery path
**Priority:** P1 | **Tags:** rag, qdrant, shadow, architecture

Make retrieval-only Qdrant and non-user-visible shadow retrieval independently operable before vLLM generation, then persist every remaining corpus, privacy, production, hardware, and advanced-RAG gate for later conversations.

### Plan

- Add failing contracts for retrieval-only startup and shadow analysis without generation or user-visible RAG output.
- Separate retrieval and generation feature flags and bootstrap boundaries while preserving bearer/ACL/fallback behavior.
- Verify focused and broad local suites plus Compose configuration.
- Record executable follow-up tasks and exact external decision gates for corpus approval, real-Qdrant evaluation/backup, shadow acceptance, vLLM, and deferred advanced RAG.

### Outcome

Implemented independent retrieval/generation/response flags with legacy compatibility, Qdrant-only bootstrap, aggregate shadow retrieval that preserves the user-visible MiniLM fallback, and explicit authorized project filtering. Added client/config/operations documentation and TASK-010 through TASK-015 for every external or later gate. TDD evidence: the focused slice first failed 10 tests for the missing contracts, then passed 21/21; final focused coverage passed 63/63, full backend-AI passed 211 with 2 opt-in live-vLLM tests skipped at 89.75% coverage, API client passed 3/3, pylint rated changed Python 10.00/10, and retrieval-only Compose rendered with Qdrant/worker but no vLLM service. No real corpus, live Qdrant recovery test, production shadow traffic, deployment, model/GPU selection, or vLLM execution is claimed.

---

## TASK-008: Add a reusable TaskPlanner workflow skill
**Priority:** P2 | **Tags:** tooling, taskplanner, codex

Create a globally discoverable Codex skill that applies the repository's `.tasks/config.json` state mapping and safe TaskPlanner lifecycle consistently.

### Plan

- Initialize a concise `taskplanner-workflow` skill with UI metadata.
- Define discovery, task selection, state transitions, planning, verification, and work-log rules.
- Validate the generated skill and record its installed path.

### Outcome

Installed `taskplanner-workflow` under the global Codex skills directory with discovery metadata and a complete safe task lifecycle. The bundled skill validator reported `Skill is valid!`.

---

## TASK-007: Record deferred advanced RAG decisions
**Priority:** P2 | **Tags:** documentation, rag, architecture

Document reranking, hybrid search, knowledge graphs, and agentic or multi-step RAG as deferred capabilities, including the evidence that should trigger reconsideration.

### Plan

- Add a future-decision register to the AI delivery roadmap.
- Define a measurable revisit trigger and acceptance evidence for each capability.
- Verify documentation formatting and preserve the active production priorities.

### Outcome

Added a deferred advanced RAG decision register with measurable revisit triggers, required adoption evidence, and an ADR gate for every capability. Verified with `git diff --check` and targeted documentation searches.

---
