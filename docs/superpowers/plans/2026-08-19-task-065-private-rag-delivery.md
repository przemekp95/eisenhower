# TASK-065 Private Generative RAG Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, evaluate, promote, and privately deploy an exact-SHA, allowlisted, single-turn grounded RAG response with a checksum-bound repository corpus while keeping MAG and every memory capability disabled.

**Architecture:** Reuse the existing FastAPI RAG application ports, canonical Mongo/Qdrant projection, provider-neutral OpenAI-compatible adapter, promotion controller, and inactive n8n RAG workflows. Add only the missing immutable activation receipt, exact-image private provider lifecycle, live readiness/credential gate, and blue-green evidence needed to turn the existing guarded capability on safely.

**Tech Stack:** Python 3.12, FastAPI/Pydantic, MongoDB 7, Qdrant, LlamaIndex, BGE-M3, private vLLM ROCm with Qwen and BGE reranker, Docker Compose, n8n 2.4.6, Bash, GitHub Actions, Trivy, CycloneDX.

**Spec:** `docs/superpowers/specs/2026-08-19-task-065-private-rag-oidc-design.md`

## Global Constraints

- Corpus input is limited to repository-approved paths; no arbitrary files, URLs, tasks, Calendar data, or transcripts.
- Tenant is `eisenhower-owner`, project is `eisenhower`, and response user is `f226f9de-1c01-4a36-9eb3-77f3313e3456`.
- Retrieval candidates are revalidated against canonical Mongo before citation output.
- Qwen generation and BGE reranking use pinned model revisions, private network-only endpoints, service credentials, bounded resources, timeouts, and circuit breaking.
- MiniLM/PyTorch MLP remains the quadrant classifier and is never described as generation.
- `MEMORY_WRITE_ENABLED`, `MEMORY_RETRIEVAL_ENABLED`, `MEMORY_RESPONSE_ENABLED`, and every MAG phase remain disabled.
- Preserve `eisenhower-e2eff0`, `eisenhower-ddb83c`, and `eisenhower-local-production`; do not remove images, volumes, or routes during deployment.
- Do not publish a public release or widen public ingress beyond the existing Calendar Funnel.

---

### Task 1: Exact private inference release contract

**Files:**
- Modify: `deploy/inference/compose.amd.yaml`
- Modify: `backend-ai/Dockerfile.response-rocm`
- Modify: `.github/workflows/release.yml`
- Verify: `.github/scripts/release-preflight.mjs`
- Modify: `deploy/generic/deploy.sh`
- Test: `backend-ai/tests/test_inference_profiles.py`
- Test: `deploy/tests/test_compose_contract.py`
- Test: `backend-ai/tests/test_release_workflow_contract.py`
- Test: `.github/scripts/release-preflight.test.mjs`

**Interfaces:**
- Produces release image `backend-ai-response-rocm` with exact `org.opencontainers.image.revision`.
- Produces immutable manifest entry consumed as both `AMD_INFERENCE_IMAGE` and `AMD_RERANKER_IMAGE`.
- Preserves the provider-neutral application contract `INFERENCE_BASE_URL`, `INFERENCE_API_KEY`, `INFERENCE_ALLOWED_HOSTS`.

- [ ] **Step 1: Write failing release/profile tests**

```python
def test_amd_response_roles_share_one_exact_release_image_without_host_ports():
  amd = yaml.safe_load(AMD_COMPOSE.read_text())
  assert amd["services"]["inference"]["image"] == "${AMD_RESPONSE_IMAGE:?immutable response image digest is required}"
  assert amd["services"]["reranker"]["image"] == "${AMD_RESPONSE_IMAGE:?immutable response image digest is required}"
  assert all("ports" not in amd["services"][name] for name in ("inference", "reranker"))
```

Add release-workflow assertions for an eighth first-party image, SBOM, all-severity scan, digest, and revision label.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `backend-ai/venv/bin/python -m pytest -q backend-ai/tests/test_inference_profiles.py backend-ai/tests/test_release_workflow_contract.py deploy/tests/test_compose_contract.py && node --test .github/scripts/release-preflight.test.mjs`

Expected: FAIL because the response image is not part of the release manifest and the AMD profile accepts two independent image variables.

- [ ] **Step 3: Implement the minimal immutable provider artifact contract**

Use one built digest for both runtime roles, preserve distinct model commands, keep `expose` only, validate model revisions and resource limits, and extend release preflight to require exactly the eight expected first-party image names. The application deploy remains independent of provider start order but fails readiness when response activation requests an unavailable provider.

- [ ] **Step 4: Render and verify GREEN**

Run the focused tests again, then render:

```bash
TASK065_ENV_FILE=/tmp/task065-safe-compose.env
docker compose --env-file "$TASK065_ENV_FILE" -f compose.yaml -f deploy/inference/compose.amd.yaml --profile '*' config --format json
```

Expected: one private application network, no inference/reranker host ports, exact model revisions, and all tests exit 0.

- [ ] **Step 5: Commit**

```bash
git add deploy/inference/compose.amd.yaml backend-ai/Dockerfile.response-rocm .github/workflows/release.yml deploy/generic/deploy.sh backend-ai/tests/test_inference_profiles.py backend-ai/tests/test_release_workflow_contract.py deploy/tests/test_compose_contract.py
git commit -m "feat(release): bind private response runtime"
```

### Task 2: Final-SHA activation receipt without repository self-reference

**Files:**
- Create: `backend-ai/app/ops/private_rag_activation.py`
- Create: `backend-ai/scripts/build_private_rag_activation.py`
- Create: `backend-ai/tests/test_private_rag_activation.py`
- Modify: `docs/ai-rebuild/corpus-owner-decision-packet.md`

**Interfaces:**
- Produces: `PrivateRagActivationReceipt` containing final Git SHA, manifest digest, corpus snapshot digest, collection, model revisions, cohort, activation/expiry, thresholds, and rollback route.
- Produces: a private JSON receipt outside the repository plus a public SHA-256 commitment.
- Consumes: exact clean Git SHA after source promotion; never embeds that SHA in a tracked corpus file.

- [ ] **Step 1: Write failing receipt tests**

```python
def test_receipt_binds_final_sha_manifest_models_cohort_and_disabled_memory(tmp_path):
  receipt = build_private_rag_activation(inputs)
  assert receipt.git_sha == "a" * 40
  assert receipt.response_users == ["f226f9de-1c01-4a36-9eb3-77f3313e3456"]
  assert receipt.memory == {"write": False, "retrieval": False, "response": False}
  assert receipt.mag_mode == "disabled"

def test_receipt_rejects_manifest_drift():
  with pytest.raises(ActivationBlocked, match="manifest"):
    build_private_rag_activation(drifted_inputs)
```

Cover dirty Git state, unapproved paths, missing corpus snapshot, missing model digest/revision, unbounded expiry, absent stop thresholds, wrong tenant/project/user, enabled memory/MAG, and missing rollback target.

- [ ] **Step 2: Run the test and verify RED**

Run: `backend-ai/venv/bin/python -m pytest -q backend-ai/tests/test_private_rag_activation.py`

Expected: collection failure because the activation module does not exist.

- [ ] **Step 3: Implement strict Pydantic models and CLI**

```python
class PrivateRagActivationReceipt(BaseModel):
  schema_version: Literal["private-rag-activation-v1"]
  git_sha: str = Field(pattern=r"^[a-f0-9]{40}$")
  corpus_manifest_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
  tenant_id: Literal["eisenhower-owner"]
  project_ids: tuple[Literal["eisenhower"], ...]
  response_users: tuple[str, ...]
  memory: DisabledMemoryFlags
  mag_mode: Literal["disabled"]
```

Hash every referenced input, write the private receipt with mode `0600`, and write only its checksum commitment to shareable evidence. Document that this external receipt avoids a Git-SHA/corpus self-reference cycle.

- [ ] **Step 4: Verify GREEN and deterministic output**

Run the focused test twice against a fixed fixture and assert byte-identical output and commitment.

- [ ] **Step 5: Commit**

```bash
git add backend-ai/app/ops/private_rag_activation.py backend-ai/scripts/build_private_rag_activation.py backend-ai/tests/test_private_rag_activation.py docs/ai-rebuild/corpus-owner-decision-packet.md
git commit -m "feat(rag): bind private activation evidence"
```

### Task 3: Governed manifest regeneration and isolated projection

**Files:**
- Modify mechanically: `docs/ai-rebuild/corpus-manifest-v1.json`
- Modify mechanically: `backend-ai/evaluation/retrieval-v1/review-candidate-v4.jsonl`
- Modify mechanically: `backend-ai/evaluation/retrieval-v1/human-review-v4.json`
- Modify: `backend-ai/scripts/generate_retrieval_review_packet.py`
- Test: `backend-ai/tests/test_retrieval_review_packet.py`
- Test: `backend-ai/tests/test_retrieval_human_review.py`
- Test: `backend-ai/tests/test_corpus_manifest.py`
- Verify: `backend-ai/scripts/run_ragops_candidate.py`

**Interfaces:**
- Produces a v4 packet bound to the current approved manifest without changing owner decisions beyond the authorization recorded in the spec.
- Produces an immutable RAGOps candidate, new `-candidate` Qdrant collection, canonical Mongo documents, snapshot, reconciliation report, and idempotency counts.

- [ ] Write failing v4 packet tests that require every source digest to match current bytes and reject the stale v3 manifest digest.
- [ ] Run `backend-ai/venv/bin/python -m pytest -q backend-ai/tests/test_corpus_manifest.py backend-ai/tests/test_retrieval_review_packet.py backend-ai/tests/test_retrieval_human_review.py` and verify RED on the stale packet.
- [ ] Regenerate the manifest from the allowlisted repository paths, generate v4 review records, and bind a fresh approval object to the exact manifest digest. Preserve exclusions and all explicit PL/EN/ACL/no-answer cases.
- [ ] Run the focused tests and verify GREEN; run `git diff --check` and inspect every changed corpus path/digest.
- [ ] Commit the mechanically bound packet with `git commit -m "docs(rag): bind approved corpus candidate"`.
- [ ] In an isolated Mongo/Qdrant runtime, run `run_ragops_candidate.py` with a new candidate ID and exact clean Git SHA. Require accepted documents > 0, pending/drift/orphan counts 0, a verified isolated snapshot restore, no alias promotion, and cleanup success.
- [ ] Run ingestion a second time against the same canonical/projection identity and record unchanged document/point counts plus idempotent receipts.

### Task 4: Physical generator evaluation and response promotion evidence

**Files:**
- Verify: `backend-ai/scripts/run_knowledge_answer_holdout.py`
- Verify: `backend-ai/scripts/ai_promotion.py`
- Modify if a discovered contract gap is reproduced first: `backend-ai/app/rag/adapters.py`, `backend-ai/app/rag/bootstrap.py`, `backend-ai/app/ops/promotion.py`
- Test if modified: `backend-ai/tests/test_rag_adapters.py`, `backend-ai/tests/test_rag_bootstrap.py`, `backend-ai/tests/test_promotion_controller.py`

**Interfaces:**
- Consumes exact inference/reranker image digest, model revisions, corpus candidate, and holdout.
- Produces checksum-bound green reports for retrieval, generation, and response; MAG stays disabled.

- [ ] Start inference and reranker on the target private application network with pinned Qwen and BGE revisions, service credentials, resource limits, and no published ports.
- [ ] Verify authenticated `/v1/models`, reranker health, image revision labels, model names/revisions, and that requests without the service credential fail.
- [ ] Run the frozen knowledge-answer holdout once with the candidate ID and store private output plus checksum. Require answerability, no-answer precision/recall, citation/schema binding, injection rejection, supported-answer rate, and latency thresholds from the approved packet.
- [ ] If any adapter/runtime defect appears, first add a focused failing test, reproduce RED, implement the smallest fix, and rerun GREEN; do not weaken thresholds.
- [ ] Register immutable RAGOps/LLMOps candidates and apply audited promotion transitions retrieval → generation → response for the explicit allowlist and validity window. Assert the pointer retains `mag.mode == 'disabled'`.
- [ ] Exercise pointer rollback and restoration before runtime activation; record exact revisions and audit entries without secrets.

### Task 5: Live-gated n8n RAG credential and workflow reconciliation

**Files:**
- Create: `n8n/scripts/import-rag-credential.sh`
- Modify: `n8n/scripts/reconcile-runtime-container.sh`
- Modify: `n8n/scripts/rehearse-runtime.sh`
- Modify: `n8n/scripts/reconcile-runtime.mjs`
- Test: `n8n/tests/reconcile-runtime.test.mjs`
- Test: `n8n/tests/test_workflow_contracts.py`

**Interfaces:**
- Produces a stable `httpHeaderAuth` credential ID through n8n's supported credential import command and verifies its encrypted database record.
- Produces `ragReady` only after live authenticated knowledge retrieval/generation checks match the activation receipt.
- Preserves three active Calendar workflows and activates exactly two RAG workflows.

- [ ] Write failing disposable-runtime tests proving a boolean environment flag alone cannot activate RAG, missing/wrong credential type fails closed, live readiness identity mismatch keeps both workflows inactive, and successful readiness activates exactly the two allowlisted RAG workflows.
- [ ] Run `node --test n8n/tests/reconcile-runtime.test.mjs` and `python3 -m unittest discover -s n8n/tests -p 'test_*.py' -v`; verify RED.
- [ ] Implement a mode-0600 temporary credential import using `n8n import:credentials`, delete the plaintext immediately, and retain `verify-runtime-credential.cjs` as the postcondition. Never print the header value.
- [ ] Extend reconciliation input from `ragReady: boolean` to a verified readiness receipt containing deployment SHA, manifest digest, collection identity, generator state, and response candidate ID. Reject drift before workflow publication.
- [ ] Run `make test-n8n` and `make test-n8n-runtime`; require a converged second reconcile, three unchanged Calendar workflow IDs, and exactly two active RAG workflow IDs.
- [ ] Commit with `git commit -m "feat(n8n): gate RAG workflows on live readiness"`.

### Task 6: Blue-green private RAG deploy and rollback contract

**Files:**
- Create: `deploy/generic/verify-private-rag.sh`
- Modify: `deploy/generic/deploy.sh`
- Modify: `deploy/generic/README.md`
- Test: `deploy/tests/test_generic_lifecycle.py`
- Test: `deploy/tests/test_docs_contract.py`

**Interfaces:**
- Consumes an eight-image release manifest, private activation receipt, environment file, and explicit blue/green project/route names.
- Produces an exact-SHA runtime with provider, projection, n8n and application readiness evidence.
- Produces route-only rollback to `eisenhower-e2eff0` and preserves `eisenhower-ddb83c` as a second layer.

- [ ] Write failing lifecycle tests for provider-before-knowledge ordering, activation-receipt SHA/digest checks, all memory/MAG flags false, exact response allowlist, failed authenticated smoke preserving the old route, route rollback, and route restoration.
- [ ] Run `backend-ai/venv/bin/python -m pytest -q deploy/tests/test_generic_lifecycle.py deploy/tests/test_docs_contract.py`; verify RED.
- [ ] Implement the verifier to inspect rendered Compose and running container environments without printing secrets, compare revision labels and activation identities, query canonical/projection counts, and require healthy generator/reranker before response activation.
- [ ] Add authenticated smoke inputs for a known approved PL and EN document, source/citation preview, task description preview/apply with `If-Match`, a no-answer/injection case, cross-scope denial, and normal task/Calendar health.
- [ ] Implement route-only rollback and restoration using explicit validated loopback project targets; never stop/remove old projects as part of the rehearsal.
- [ ] Run lifecycle tests and an isolated disposable rehearsal; commit with `git commit -m "feat(deploy): verify private RAG blue green rollout"`.

### Task 7: Repository verification and exact-SHA promotion

**Files:**
- Modify: `.tasks/IN_PROGRESS.md`
- Modify on genuine completion only: `.tasks/DONE.md`, `.tasks/WORK_LOG.md`
- Verify: all changed source and policy files.

**Interfaces:**
- Consumes completed OIDC and RAG implementation commits.
- Produces one exact final SHA at both `origin/master` and `origin/dev` with green post-merge CI.

- [ ] Run focused web, AI, deployment, release, n8n, API-client, Node and contract suites; preserve exact command/count evidence.
- [ ] Run `make verify` from repository root and require exit 0; run `git diff --check`, workflow YAML parsing, and `actionlint` if available.
- [ ] Re-read both TASK-065 specs requirement-by-requirement and inspect the complete branch diff for unintended corpus, Calendar, public ingress, MAG, memory, or secret changes.
- [ ] Push the exact feature head and open a protected feature-to-`dev` PR. Require all checks on that exact head before merge.
- [ ] Fetch after merge, verify the exact `dev` push CI, then open protected `dev`-to-`master`; require exact-head checks before merge.
- [ ] Fetch after master merge, verify master push CI and governed master-to-dev sync CI, then prove `origin/master == origin/dev` and correct ancestry from the feature head.

### Task 8: Final-image evidence and authenticated private activation

**Files:**
- Store runtime evidence outside Git: `/home/przemekp95/.runtime-cache/eisenhower-<project>/evidence/`
- Update after observed results: `.tasks/IN_PROGRESS.md` or `.tasks/DONE.md`, `.tasks/WORK_LOG.md`

**Interfaces:**
- Consumes the exact synchronized final SHA and release manifest.
- Produces private runtime, smoke, rollback, SBOM and scan evidence without public publication.

- [ ] Build all eight first-party images from the exact final SHA and verify every OCI revision label.
- [ ] Generate CycloneDX SBOMs and run Trivy with all severities for every final image; stop on any policy-blocking result rather than relabeling it.
- [ ] Generate the external final-SHA activation receipt and verify its checksum against the runtime manifest, corpus, projection, models, cohort, expiry, thresholds, and rollback targets.
- [ ] Deploy a new uniquely named blue-green project on a new validated loopback port, attach the private provider services to its controlled network, and keep all existing runtimes running.
- [ ] Ingest the approved corpus, verify Mongo/Qdrant counts and idempotent rerun, apply promotion pointer phases, reconcile the n8n credential/workflows after live readiness, then enable generation/response for only the approved user.
- [ ] Execute authenticated OIDC and RAG smoke: approved answer with bound citations/source preview, explicit task-description preview/apply, unsupported no-answer, injection abstention, tenant/project/user isolation, provider failure fallback, and memory/MAG disabled capability output.
- [ ] Route Tailscale private traffic to the new runtime, verify it, route back to `eisenhower-e2eff0`, verify rollback behavior, then restore the new route and verify again. Do not alter the public Calendar Funnel route.
- [ ] Record exact SHA/CI, corpus/projection, generator/reranker, flags/cohort, private route, smoke, n8n, scans/SBOM, rollback, and open human/real-traffic/physical gates separately.
- [ ] Move TASK-065 to Done only if every owner-authorized software, promotion, and private-deploy outcome is complete; otherwise keep it In Progress with a precise remaining gate.
