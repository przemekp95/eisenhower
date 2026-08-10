# Done

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
