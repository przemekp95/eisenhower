# Next

## TASK-005: Install and smoke-test the release APK on physical Android
**Priority:** P0 | **Tags:** android, physical, acceptance

Install the exact release APK produced for the promoted SHA on a physical Android device and verify public task CRUD plus MiniLM classification.

### Plan

- Download and install the immutable CI release APK.
- Read back task CRUD and classification results against the public HTTPS runtime.

---

## TASK-004: Rehearse independent backup, restore, and rollback
**Priority:** P0 | **Tags:** operations, backup, rollback

Preserve production data, create an independent backup, restore it into an isolated target, compare the restored data, and verify application rollback to a prior immutable SHA.

### Plan

- Inventory and back up MongoDB and AI data without modifying the live source.
- Restore into an isolated target and verify counts/checksums.
- Rehearse application rollback and record exact evidence.

---

## TASK-003: Promote and verify the supported Mikrus runtime
**Priority:** P0 | **Tags:** release, mikrus, public-runtime

After evaluation and CI gates pass, promote `dev` to `master` through the required PR, release the immutable SHA, deploy it through the existing supported workflow, and run the complete public HTTPS acceptance suite.

### Plan

- Require green checks on `dev` and the `dev` to `master` PR.
- Publish and deploy only the exact master SHA.
- Verify health/readiness, authorization, CRUD, MiniLM, OCR, Origin/CORS, and mixed-content behavior.

---

## TASK-002: Benchmark and approve the frozen production evaluation
**Priority:** P0 | **Tags:** ai, evaluation, production-gate

Run the MLP, centroid, and incumbent comparison on the frozen human-approved dataset, preserve the exact dataset SHA-256 and encoder revision, and promote only if every production threshold passes.

### Plan

- Finalize and freeze the human-approved evaluation packet.
- Run the production profile benchmark against the exact immutable dataset.
- Keep promotion fail-closed on governance, quality, stability, leakage, or approval-SHA failure.

---
