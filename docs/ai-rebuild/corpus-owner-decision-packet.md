# First RAG corpus owner decision packet

Status: approved for local implementation and controlled evaluation
TaskPlanner gate: TASK-010
Last prepared: 2026-08-10

This packet is the minimum information required before Eisenhower indexes any real content. A blank,
ambiguous or unanswered item is a no-go for that source. Approval covers only the named corpus and
does not authorize deployment, production shadow traffic, vLLM, memory writes or publication.

## Proposed smallest useful slice

The recommended first slice answers one bounded question: _which reviewed project constraint,
decision or procedure is relevant to prioritizing this task, and why?_ It uses one allowlisted,
read-only connector and produces citations to the reviewed source revision.

The safest candidate is a small, manually reviewed set of project-owned decision, procedure and
project-context documents. Live tasks, notes, chats, email, calendars, browser history, arbitrary
URLs, attachments and OCR are excluded unless separately named and approved below.

The repository owner granted explicit approval for the full project-controlled corpus scope in this
Codex task on 2026-08-10. That approval does not cover secrets, permission-ambiguous content,
unreviewed external data, deployment or publication.

## Required owner answers

Copy the answer block, replace every `REQUIRED` value and explicitly keep or change each proposed
default. Do not add credentials, personal data or document contents to this file.

```yaml
decision_version: "corpus-decision-v1"
product_owner: "Eisenhower repository owner"
data_owner: "Eisenhower repository owner for project-controlled sources"
privacy_owner: "Eisenhower repository owner; review required again before external or third-party data"

use_case:
  question: "Which reviewed project constraint, decision or procedure is relevant to prioritizing this task, and why?"
  success_measure: "At least 80% of reviewed PL/EN samples return useful accessible project context, with zero forbidden hits"
  out_of_scope_answers: "No autonomous task changes; no answer without an accessible supporting citation"

tenancy_and_identity:
  initial_tenant_model: "single-tenant pilot implemented with mandatory tenant/user/project fields"
  identity_authority: "verified bearer/OIDC principal; fixed local identity only for synthetic tests"
  project_membership_authority: "signed allowlisted connector configuration bound to the verified principal"
  acl_derivation: "connector-owned tenant/project mapping intersected with verified user and role subjects"
  cross_tenant_support: "disabled"

sources:
  connector_type: "allowlisted read-only repository/document connector; no generic URL fetcher"
  connector_identity: "dedicated read-only ingestion identity bound to the approved manifest"
  canonical_store: "MongoDB rag_documents collection persisted and reconciled before Qdrant writes"
  approved_source_roots:
    - "README.md"
    - "docs/PRODUCTION_ACCEPTANCE.md"
    - "docs/ai-rebuild/**/*.md except governance packet and generated manifest"
    - ".tasks/{BACKLOG,NEXT,IN_PROGRESS,DONE,REJECTED,WORK_LOG}.md"
    - "corpus/approved-documents/**/*.{pdf,docx,pptx,html}"
  approved_source_types:
    - "project_context"
    - "decision"
    - "procedure"
    - "runbook"
    - "task"
  approved_media_types:
    - "text/markdown"
    - "application/pdf"
    - "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    - "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    - "text/html"
  approved_extensions:
    - ".md"
    - ".pdf"
    - ".docx"
    - ".pptx"
    - ".html"
  source_revision_rule: "manifest version plus per-file SHA-256; changed content creates a new source sequence"
  maximum_document_bytes: 20971520
  maximum_corpus_documents: 500

document_extraction:
  docling_primary_formats: ["pdf", "docx", "pptx", "html"]
  unstructured_fallback_formats: ["pdf", "docx", "pptx", "html"]
  fallback_trigger: "only PRIMARY_UNSUPPORTED_LAYOUT or PRIMARY_QUALITY_BELOW_APPROVED_THRESHOLD; never security/resource failures"
  ocr_enabled: true
  ocr_review_threshold: "every OCR-derived document requires human approval before indexing; confidence never bypasses review"
  maximum_document_pages: 500
  minimum_primary_text_characters: 20
  maximum_wall_seconds: 120.0
  maximum_peak_memory_bytes: 4294967296
  resource_limit_behavior: "reject without fallback on timeout, out-of-memory or any budget breach"
  encrypted_documents: "reject"
  archives: "reject"
  embedded_executables: "reject"
  external_url_fetching: "reject"

privacy_and_governance:
  ownership_or_license_basis: "project-controlled repository content and explicitly contributed approved documents"
  pii_policy: "detect and redact before canonical storage; reject if safe redaction or ownership cannot be established"
  secrets_policy: "reject and alert without logging the secret"
  data_residency: "user-controlled local environment and explicitly approved EU target only"
  retention_period: "source-linked lifecycle; remove within 24 hours of an accepted deletion"
  deletion_sla: "24 hours for canonical store and active vector projection"
  tombstone_retention: "90 days for replay prevention and deletion audit, without original content"
  backup_retention: "30 days maximum; deletion propagates on the next verified backup rotation"
  audit_retention: "365 days of metadata-only events"
  human_review_sampling: "100% of initial and OCR-derived corpus; minimum 10% of later non-OCR updates"

explicit_exclusions:
  - "raw task history"
  - "chat and email"
  - "calendar attendee data"
  - "browser history"
  - "unreviewed OCR"
  - "binary attachments"
  - "credentials, secrets and hidden prompts"
  - "deleted or permission-ambiguous records"
  - "historic quadrant 1/2 data not explicitly migrated and reviewed"
  - "all .env files, credentials, private keys, database dumps, uploads and build artifacts"
  - "third-party or external content without explicit ownership and ACL evidence"

transition:
  synthetic_fixture_set: "backend-ai/tests/fixtures/document_extraction/manifest.json; SHA-256 frozen when TASK-018 creates it"
  real_data_sample: "documents enumerated by docs/ai-rebuild/corpus-manifest-v1.json"
  rollback_owner: "Eisenhower repository/runtime owner"
  privacy_deletion_owner: "Eisenhower repository owner"
  qdrant_operations_owner: "Eisenhower runtime owner"
  approval_expires_or_review_date: "2026-11-10"

approvals:
  product_owner_decision: "approve full project-controlled local scope; reconfirmed in Codex task on 2026-08-11"
  data_owner_decision: "approve project-controlled sources and reviewed contributed documents"
  privacy_owner_decision: "approve with mandatory redaction, OCR review, deletion and fail-closed exclusions"
  approved_manifest_sha256: "b022333de73442927099881fdb4e327d7edea0feb1eba9ad809511e9ccec9f5f"
```

## Documents needed from the owners

1. The completed answer block with accountable roles and explicit approve/reject decisions.
2. An allowlist of exact source identifiers and immutable revisions, without credentials or content.
3. The permission or license basis for every source root.
4. A sample inventory containing document IDs, source types, language, media type, byte size and PII
   classification, but no raw private content.
5. The identity and membership mapping used to derive tenant/project/user/role ACL subjects.
6. Retention, deletion, backup and audit rules, including responsible owners and maximum SLAs.
7. If document parsing is in scope, the approved format matrix and OCR/fallback review policy.

## Fail-closed acceptance checklist

- [x] Every source has an accountable owner, permission basis and immutable revision rule.
- [x] Identity and ACL derive from a trusted authority rather than request payload metadata.
- [x] PII, secret, retention, deletion, backup and audit rules are explicit.
- [x] One connector, exact roots, formats, size/count limits and exclusions are allowlisted.
- [x] Synthetic fixtures and the transition to a reviewed real sample are separately approved.
- [x] The final manifest is frozen and its SHA-256 is signed off by the required owners.
- [x] No decision in this packet is treated as deployment, production traffic or publication approval.

Until every applicable checkbox passes, implementation may use only synthetic fixtures and no real
content may be written to the canonical store, Qdrant, prompts, logs or evaluation artifacts.
