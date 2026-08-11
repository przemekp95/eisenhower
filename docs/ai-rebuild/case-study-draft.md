# Eisenhower AI rebuild — evidence-led case study draft

Last verified locally: 2026-08-11
Publication status: **private draft; publication is not authorized**

## One-sentence summary

Eisenhower is being rebuilt as a multilingual, privacy-governed RAG system with a canonical MongoDB document lifecycle, an ACL-filtered Qdrant projection, governed Docling extraction, private vLLM as a gated target, and explicit-consent user memory kept outside the knowledge index.

This draft deliberately reports failed and missing gates. It is not a production-readiness or deployed-capability claim.

## Evidence map

| Capability | Strongest current evidence | Honest status |
| --- | --- | --- |
| Corpus governance | Owner-refrozen 19-document snapshot and manifest; manifest SHA `b022333d...9f5f` | Approved for local implementation; not proof of public distribution rights |
| Canonical RAG ingestion | Real local Mongo → Qdrant ingestion and zero-drift reconciliation | Local container runtime only |
| Qdrant recovery | Snapshot download/checksum, isolated restore, alias cutover/rollback, physical tombstone removal | Local Qdrant 1.12 runtime; no target-environment recovery drill |
| Retrieval quality | Real MiniLM + Mongo + Qdrant baseline over 18 proposed PL/EN cases | **Fails unchanged proposed quality gates and lacks independent human label approval** |
| Document extraction | Docling primary for governed PDF/DOCX/PPTX/HTML/OCR fixtures; Unstructured is reason-limited fallback | Local fixtures and local runtime only |
| Private generation | Typed vLLM adapter, immutable prompt contracts and fail-closed configuration | Target only: no approved model/GPU, live vLLM, shadow generation or response canary |
| Information delta | Explicit checksummed known-state, typed novelty relations, semantic/citation validation and current-world abstention | Source, PL/EN tests and mocked private-vLLM HTTP only; no live model claim |
| Consent-governed memory | Transactional Mongo lifecycle, separate content-free Qdrant projection, HMAC confirmation, revalidation and physical deletion | Local isolated runtime; all rollout flags remain off |
| Retrieval shadow pilot | Code supports retrieval/generation/response separation | Not deployed; no real traffic or production telemetry |
| Read-only MCP | Six-tool MCP SDK v2 contract, separate task/AI upstreams, mandatory fail-closed configuration | 21 adapter tests plus a real local stdio subprocess and SDK handshake against current Node/FastAPI source, isolated MongoDB and Qdrant; not deployed |
| AI observability | Bounded-label metrics, Prometheus rules and provisioned Grafana dashboard | Ephemeral local runtime proved real scrape and Grafana query; no deployment or production time series |
| Web demo surface | Explicit RAG/fallback/no-answer UI with inert citations and accessible desktop/mobile modal | 134 mocked-contract tests at 100% coverage plus real local Chromium/Pixel 7 → Vite → FastAPI → MiniLM → Mongo/Qdrant proof; deterministic test generator, not vLLM or deployment |
| Public demo | Private draft only | Not deployed or published |

## Architecture and trust boundaries

```text
reviewed sources
  -> governed Docling primary / controlled Unstructured fallback
  -> normalized canonical document in MongoDB
  -> deterministic chunks + pinned multilingual MiniLM
  -> private Qdrant knowledge projection with tenant/project/ACL filters
  -> retrieval-only evaluation and shadow gate
  -> private vLLM target with structured output and citation validation
  -> deterministic MiniLM+MLP fallback

explicit user confirmation
  -> tenant/user-scoped canonical memory in transactional MongoDB
  -> separate Qdrant memory projection without raw content
  -> Mongo revalidation
  -> bounded, untrusted memory prompt data (disabled until later gates)
```

FastAPI remains the online application and authorization boundary. Web/mobile and MCP clients do not access MongoDB, Qdrant, vLLM or n8n directly. n8n is limited to signed, asynchronous commands and cannot decide consent, relevance or the online answer.

## Decision record

| Decision | Chosen boundary | Why this is intentional |
| --- | --- | --- |
| Canonical knowledge | MongoDB owns document state; Qdrant is a disposable projection | Deletion, ACL and provenance remain reviewable even when vector writes fail or an index must be rebuilt |
| Extraction | Project-owned port with governed Docling primary and reason-limited Unstructured fallback | Parser objects and permissive framework defaults cannot become the domain or bypass source/OCR policy |
| Delivery order | Retrieval quality and retrieval-only shadow precede vLLM | A fluent generator cannot hide weak Polish retrieval, forbidden hits or an unapproved relevance set |
| Generation | One private, revision-pinned vLLM target behind a typed port | Avoids unsupported multi-runtime claims and keeps JSON, citation, no-answer and fallback checks application-owned |
| Information delta | Model proposes a delta; an application validator compares it with explicit state and allowed sources | Prompt wording cannot enforce novelty, and a frozen corpus cannot prove current-world freshness |
| User memory | Separate Mongo/Qdrant lifecycle with explicit, intent-bound confirmation | Classifier feedback, retrieved documents and inferred preferences cannot silently become durable memory |
| Integration | Read-only MCP; n8n only for signed asynchronous commands | Neither integration receives direct database access or authority to decide relevance, consent or an online response |
| Observability | Allowlisted aggregate labels; one Uvicorn worker per container for the current in-process counters | Prevents content/identity leakage and makes the current process-local state limitation explicit |

## Evidence ladder and non-goals

Repository source and mocked contract tests show implemented behavior, not reachability. Isolated local-container reports show the named processes and stores interacted, not deployment. Only an immutable deployed SHA, target telemetry and an independently checked public endpoint could support deployed or public claims; none exists yet.

This rebuild intentionally excludes generic URL/email/chat ingestion, arbitrary database or filesystem tools, autonomous agents, silent memory inference, a second vector database, multiple competing LLM servers and Kubernetes/cloud manifests without an operated target. Reranking, hybrid search, knowledge graphs and multi-step RAG require measured triggers and separate ADRs.

## Reproducible local evidence

The following artifacts are immutable inputs or generated local reports in this worktree:

| Artifact | SHA-256 | What it proves |
| --- | --- | --- |
| `docs/ai-rebuild/corpus-manifest-v1.json` | `b022333de73442927099881fdb4e327d7edea0feb1eba9ad809511e9ccec9f5f` | Owner-refrozen source/parser/OCR policy used by current local runs |
| `backend-ai/evaluation/document-extraction-smoke-v1.json` | `ad354ca4c4cb7ae3108fa9d0654b0a197cc76feb2a7ec4ce5265cb80c3dff5d8` | 11/11 governed synthetic extraction cases and dependency revisions |
| `backend-ai/evaluation/qdrant-recovery-local-v1.json` | `39a71c3fe3f4aac3658dd93f2ad60ae3a8f164b8c6d82e160fa5772c391e02bb` | Refreshed real local snapshot/restore, isolation and alias rollback |
| `backend-ai/evaluation/retrieval-v1/review-candidate-v1.jsonl` | `5966f79ee4f9e04f9485073c3efc7c86195aeedd615ae7aeb8bf89132f1b1ba0` | Refreshed 18-case candidate awaiting independent human review |
| `backend-ai/evaluation/retrieval-v1/human-review-v1.json` | `64681ab1c55242683d45a035f7b731c95e92de17e7bcfbea86f1a0b0bc6bbfc3` | Hash-bound fail-closed review template; all 18 human decisions remain pending |
| `backend-ai/evaluation/retrieval-v1/candidate-local-runtime-v1.json` | `16ff06d03483b803d373bd35d2743649485436908ba9c9420114a95d7cb9d0b8` | Untuned real local retrieval baseline and isolated cleanup |
| `backend-ai/evaluation/retrieval-v1/candidate-local-assessment-v1.json` | `f7f63566a6370edc6eca1faf2e26090f783a1c7e2a865767e44fb6cedbc8da3d` | Mechanical no-go assessment against unchanged, still-unapproved thresholds |
| `backend-ai/evaluation/memory-runtime-local-v1.json` | `77d6ac82f1f42ae02093a8926c37392cc92c1971230d18e196ce36386c2e8b4a` | Real local transactional lifecycle, active-conflict rollback, canonical revalidation and separate projection |
| `monitoring/alert_rules.yml` | `f25ee3705b33cfd3324b2a41f832ad07f410eda51815913f0a0a4bed1b165e4f` | Eight syntax-validated operational alert rules |
| `monitoring/grafana/dashboards/eisenhower-ai.json` | `34e073cad91825f1f83c29f38b8cb47dadd8dd689c8d0d85227aea781cf1d7d9` | Provisioned, privacy-bounded online telemetry dashboard definition |
| `backend-ai/evaluation/observability-runtime-local-v1.json` | `f158548d18a22026967466f1fc3f1d9dc19791d31e0b54ee5abc21ad9751801f` | Historical source-bound local Prometheus/Grafana/FastAPI scrape and dashboard query; current same-tree telemetry still requires a new release rehearsal |
| `backend-ai/evaluation/mcp-full-runtime-local-v1.json` | `02b0462c75274012edc8708fc755a8f524c20e54c11cca4e5c498d4ab377ebbb` | Refreshed six-tool stdio/SDK runtime to current Node/FastAPI, isolated MongoDB/Qdrant, citations, project isolation and verified cleanup |
| `backend-ai/evaluation/web-rag-browser-runtime-local-v1.json` | `d7492249cf8c1960ec8b9be5873abf18dab1393f330ddffe4fce85276568ae51` | Real desktop/mobile browser network path to current FastAPI, isolated canonical/vector stores, ACL probe and citation DOM; deterministic test generator only |
| `backend-ai/evaluation/vllm-hardware-local-v1.json` | `78abcfd56f1cb54d8dd484e4b97c0e63c015227239b67f8be3eac46232a47be7` | Official-container visibility of the local AMD `gfx1151` candidate; no vLLM/model run |

The retrieval baseline is intentionally not presented as a success: Recall@5 is `0.6667`, MRR@5 is `0.5444`, and no-answer accuracy is `0.9444`. PL Recall@5/MRR@5 is `0.4375`/`0.4375`; EN Recall@5 passes the proposal at `0.9286`, while EN MRR@5 is `0.6667`. Isolation, forbidden-hit, stale-hit and duplicate-hit rates were zero, while warm local p95 retrieval latency was `14.70 ms`. Labels and thresholds remain unapproved, so these are diagnostic numbers, not final acceptance results. The machine finalizer exists and is tested, but it deliberately emits only a self-attested record and cannot supply or prove the missing independent human judgment.

Fresh backend regression evidence after the information-delta contract is `385 passed, 7 skipped` at `89.28%` coverage. Earlier unchanged evidence for the other surfaces remains: backend Node `66 passed` plus TypeScript build; web `134 passed` at 100% coverage plus build/format and `6/6` regular Playwright checks; MCP `21 passed` with warnings as errors; n8n contract tests `5/5`. The new delta tests include PL/EN paraphrases, repetition, contradiction/update, necessary reminders, no-new-information, prompt injection, budgeting, API forwarding and a mocked private-vLLM HTTP contract. They do not prove a live vLLM/model run. The separate unmocked browser runtime is recorded in its own source-bound artifact above.

## Failure and rollback story

- Parser policy rejects unsupported, encrypted, archive, executable and unapproved OCR inputs before canonical ingestion.
- MongoDB is canonical; a failed Qdrant write remains reconcilable instead of becoming an untracked source of truth.
- Qdrant versions are switched through a guarded alias and the prior collection is retained for rollback.
- Tombstoned documents and revoked/deleted memories are physically removed from their vector projections.
- Missing retrieval, unavailable generation, malformed output or invalid citations falls back or returns no-answer according to policy; it is never relabeled as successful RAG.
- Repeated or unsupported information-delta claims are rejected after generation; lack of a supported delta returns `no_new_information`, while requests that require the current world return `freshness_unverified` without model generation.
- MCP has no default upstream: both the task API and AI API must be configured explicitly, remote URLs require HTTPS, and Streamable HTTP remains loopback-only behind an authenticated gateway.
- The local MCP rehearsal used a separate stdio server process and its real environment composition root, not an in-process dispatcher. It exercised all six tools against two synthetic isolated tasks and the frozen repository corpus, returned five citations, and returned zero hits for the wrong-project probe. The report binds the dirty source trees and dependency inputs by hash; it is not a deployed or immutable-release-SHA claim.
- Operational metric labels are allowlisted; tenant, user, prompt, document, chunk and memory content are not accepted as labels. Offline evaluation is deliberately not imported into the online dashboard.
- The local observability rehearsal exposed a real multi-worker correctness defect: the custom metrics and provider/model state are process-local. Both production images now use one Uvicorn worker per container; scaling must use separate scraped instances until a shared-state design exists.
- Memory text is explicit user data, not an instruction channel. Every mutation is intent-bound and confirmed. An owner-defined `conflict_key` plus a transactional partial unique index rejects concurrent active conflicts; supersession requires a separately confirmed replacement.
- The refreshed local browser rehearsal used real Chromium desktop and Pixel 7 network requests through current Vite and FastAPI to real isolated Mongo/Qdrant, with an explicit wrong-user ACL probe and verified cleanup. Its generator is deliberately deterministic and test-only, so it proves transport/retrieval/citation plumbing but not vLLM, prompt/model quality or deployment.
- The n8n import artifact now preserves exact raw bytes and FastAPI verifies a version/timestamp/method/path-bound HMAC before strict parsing, with an 8 MiB limit and atomic replay reservation. Static contracts passed; the workflow was not imported or activated against a real n8n/gateway/TLS path.

## What remains before this can be published as a working demo

1. An independent human must review every TASK-013 relevance label and approve final thresholds.
2. Retrieval must pass the approved global, PL, EN and holdout gates without tuning against holdout.
3. A separately authorized internal deployment must complete the retrieval-only shadow pilot with privacy-safe telemetry and rollback evidence.
4. The actual target GPU/VRAM, licensed model, tokenizer and chat template must be selected and exercised through private vLLM.
5. Live generation must pass structured-output, citation, no-answer, adversarial, capacity, OOM and fallback gates before any response canary.
6. MAG needs the approved retrieval/generation baseline before write, retrieval or response flags may be enabled for users.
7. The demo needs an authorized immutable SHA, public HTTPS verification, accessibility/mobile checks and a claim-by-claim external review.

Until those items are complete, the defensible portfolio claim is: **implemented and exercised locally with explicit governance and reproducible failure evidence**, not “production AI platform.”
