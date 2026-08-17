# Private case-study evidence delta — 2026-08-17

Status: **private working evidence; publication is not authorized**.

This file records changes that are newer than `case-study-draft.md`. The draft is part of the approved,
hash-bound RAG corpus, so editing it without a new corpus review changes frozen retrieval document IDs.
This delta deliberately leaves that canonical input untouched and is not itself a publication artifact.

Source base: `608bfd9b2557364922293f9e5de4988d61c922b3` plus the candidate implementation described below.
Until its exact promotion evidence is recorded, this is not an immutable release or deployed-SHA claim.

## New source and local evidence

| Area | Evidence | Boundary |
| --- | --- | --- |
| Retrieval/canary rehearsal | `backend-ai/evaluation/shadow-rollout-local-rehearsal-20260817.json`, SHA-256 `47b71106a659cb9d4fa2bdc685ebc0481534575ccdc4fde249cdba62236f3b1b` | Deterministic local preflight only; no runtime mutation, cohort or traffic |
| MAG runtime/API | Conditional FastAPI composition, canonical Mongo lifecycle, separate Qdrant projection, prepare/confirm/export/revoke/delete and aggregate-only retrieval shadow | All flags default false; no deployed store, write or real-user proof |
| MAG UI | Capability-gated web controls with server receipt preview, separate confirm, idempotency, export and separately confirmed revoke/delete | Hidden while memory writes are disabled; no real-user consent evidence |
| Grounded RAG parity | Mobile now uses `/v2/knowledge/answer` with citations, no-answer, cancellation and editable apply preview; web adds explicit cancellation | Automated client contract only; real backend traffic remains unproven |
| Camera parity | Separate web/mobile camera and gallery paths, mobile permission/offline state and review-before-upload/import; contract SHA-256 `4638add205bd935258cf3679214e0908c8e3db29a0fdc2f9a7eeb96206708169` | Android release build and mocked behavior are not physical camera evidence; `exif:false` is not proof that file bytes were scrubbed |

### Image-upload privacy addendum

The current worktree candidate closes the earlier byte-scrubbing caveat without changing the frozen
case-study draft. A shared fail-closed parser removes JPEG EXIF/XMP, IPTC and comment segments plus PNG
EXIF/text chunks. The web creates and uploads a new sanitized JPEG/PNG `File`, passes plain text through
unchanged and rejects unsupported image encodings. Mobile re-encodes the reviewed picker asset to a
temporary JPEG, scrubs its bytes, uploads only that cache URI and deletes it after success or failure;
offline selection still creates no upload file.

Fresh candidate evidence:

- API client: `33 passed` plus TypeScript declarations, including literal JPEG/PNG byte fixtures,
  progressive-scan metadata removal and malformed-input rejection;
- web: `221 passed`, formatting and production build, including image sanitization when the browser
  supplies no MIME type;
- mobile: `202 passed`, `5` security tests and production dependency audit with `0` vulnerabilities;
- native Android: clean Expo prebuild followed by `352` Gradle release tasks, with `BUILD SUCCESSFUL`;
- local CI-candidate APK: v2 signature verified, SHA-256
  `8337163cde3308c8ae766996d037bee397576fc4ada875930a321274b59187cf`.

This is source, test and local-build evidence only. The APK is not production-signed or installed, the
candidate has no promoted immutable SHA, and no physical camera, assistive-technology, real-backend or
public-runtime acceptance is implied.

Final local verification:

- backend AI: `819 passed, 12 skipped`; local deployment contract: `30 passed`;
- API client: `28 passed` plus TypeScript;
- web: `217 passed` at 100% coverage, 2 integrations, formatting and production build;
- web E2E: `24 passed` across desktop, 390 px and 320 px Chromium;
- mobile: `197 passed` with the 90% branch gate, production dependency audit, Expo native permission introspection and an isolated signed Android release build;
- shadow rehearsal slice: `37 passed`, Pylint `10.00/10`.

The repository-wide `make verify` gate passed after these changes. The Python dependency audit still
records its declared non-PyPI blind spots for the hash-verified direct ML wheels; this result is not a
claim that those skipped wheels were vulnerability-audited.

## Claims that remain forbidden

- TASK-014 and TASK-023 are not closed: they still lack current-SHA deployment, persistent same-SHA
  telemetry, an authorized cohort, real traffic, reviewed sampling and a signed decision.
- TASK-019 is not running for users: the consent, retrieval and response flags remain disabled and the
  repository policy still refuses deployment.
- TASK-028 has automated contract parity and byte-level upload privacy, not physical
  Android/iOS/mobile-browser camera or assistive-technology acceptance.
- TASK-047 still lacks the dual-human classifier annotation and genuine production benchmark.
- No public HTTPS demo, public deployment or publication approval exists.

Before this delta can be folded into the canonical case study, refreeze the governed corpus and rerun the
retrieval review workflow. Publication additionally requires the remaining real-world evidence and a
separate explicit approval.
