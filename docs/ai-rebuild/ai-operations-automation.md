# Local and CI AI candidate operations

The project uses its own private, dependency-light artifact registry before considering MLflow or
another permanent service. A candidate is immutable evidence, never an authorization to promote,
deploy or publish.

## Shared lineage

`ai-candidate-v1` binds the Git SHA and dirty state to checksummed datasets, model or encoder
receipts, PromptSpecs and schema, corpus and Qdrant receipts, runtime versions and reports. Every
lineage group is either populated or carries an explicit not-applicable reason. Blobs are stored by
SHA-256 under private `0700` directories with `0600` files. Conflicting writes and checksum drift
fail closed; the registry has no delete or promotion operation.

Use `backend-ai/scripts/ai_artifact_registry.py` to register or verify artifacts. Registry roots and
CI artifacts must remain private because lineage can still reveal internal version metadata even
though prompts, corpus text and identifiers are excluded.

## Candidate pipelines

- `run_mlops_candidate.py` reuses the grouped-CV, five-seed, leakage, PL/EN slice, centroid,
  incumbent and threshold benchmark. It requires the development gate but preserves the failed
  human/production gate and never changes `local_minilm_current.json`.
- `run_ragops_candidate.py` uses live CI MongoDB and Qdrant for approved-manifest extraction,
  canonical-before-vector ingestion, reconciliation and retrieval evaluation. A separate real
  Qdrant snapshot/download/isolated restore/alias rollback proof supplies the retained candidate
  snapshot. The candidate alias is never promoted and the temporary services are cleaned up.
- `run_llmops_candidate.py` validates checksum-bound PL/EN PromptSpecs, budgets, schema and
  independently frozen mock outputs against adversarial golden cases. This is an in-process
  schema/safety/regression contract probe, explicitly not a model-quality evaluation. Its evidence
  level is `ci_in_process`, it records that no model ran and cannot satisfy the live-model gate.

GitHub Actions never uploads the private registry, full manifests, datasets, prompts or snapshots
from this public repository. It retains for 14 days only allowlisted public commitment receipts
binding candidate id, workflow, Git SHA and manifest checksum. The full immutable registry remains
private in the local filesystem; configuring durable private CI storage is an external owner gate.

The RAGOps CI step is additionally fail-closed behind `ENABLE_RAGOPS_CANDIDATE=true`. Enable it only
after the owner re-freezes the current 19-file corpus snapshot and the physical checksum matches the
manifest. At the 2026-08-11 implementation point, the checked-in manifest hash was `7d52fdd5...`
while the current files calculated `7da7720b...`; both fresh local attempts stopped before ingest.

## Quality, drift and promotion

The quality monitor accepts only aggregate numeric snapshots for classifier, retrieval,
generation, response and MAG. Missing phases, missing samples, metric or slice drift block the
report. Field names associated with prompts, tokens, content, citations, PII or private identifiers
are rejected before serialization.

`ai_promotion.py` is dry-run by default. Its atomic local pointer governs these phases independently:

| Phase | Runtime boundary |
| --- | --- |
| retrieval | `RAG_RETRIEVAL_ENABLED` |
| generation | `RAG_GENERATION_ENABLED` |
| response | `RAG_RESPONSE_ENABLED` |
| MAG | the separate memory write, retrieval and response gate set; one phase never enables another |

Legal progression is `disabled -> shadow -> canary -> enabled`. Every transition requires an
immutable registered candidate, a matching fresh checksummed green report and an out-of-band owner
approval receipt authenticated with an owner-controlled HMAC key file (`0600`, at least 32 bytes).
Stable canary assignment uses only a caller-supplied pseudonym and stores no
subject identifier. `--apply` changes only the local atomic pointer; it never deploys. Previous
pointers are retained for rollback. Applied transitions and rollback additionally require
`--audit-database`, a separate `--audit-key-file` with `0600` permissions, and the exact
`--release-sha`; the command fails closed before changing the pointer when that durable audit
configuration is incomplete. Dry runs remain non-mutating and may omit it.

TASK-001, TASK-002 and TASK-013 remain human gates. Hardware, model, GPU, quantization and license
selection remain TASK-015. Live vLLM, production traffic, shadow/canary deployment, publication,
commit and push require separate authorization.

The application remains pragmatic layered/modular code with useful ports and adapters. HTTP is the
online request path. n8n, the durable queue and worker remain async ingestion/reindex/evaluation
infrastructure. This automation does not make the repository full DDD, BDD, CQRS or strict
hexagonal architecture, and test presence alone does not prove historical TDD. A task may make a
bounded TDD claim only when its implementation record preserves the intended red and later green checks.
