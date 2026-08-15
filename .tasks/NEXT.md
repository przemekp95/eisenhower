# Next

## TASK-005: Install and smoke-test the release APK on physical Android
**Priority:** P0 | **Tags:** android, physical, acceptance

Install the exact release APK produced for the promoted SHA on a physical Android device and verify public task CRUD plus MiniLM classification.

### Plan

- Configure a user-owned, recovery-backed production keystore and pin its public certificate SHA-256 without committing secrets.
- Require the post-`master` release workflow to reject debug or unpinned signatures, then download its immutable APK and checksum metadata.
- Install the production-signed APK; a debug-signed CI candidate does not satisfy this task.
- Read back task CRUD and classification results against the public HTTPS runtime.

### Conditional checkpoint

The repository owner approves every human decision in this task green without reservations through 2026-08-23 23:59:59 Europe/Warsaw. The real keystore, immutable release APK and physical-device result remain technical acceptance evidence.

---

## TASK-004: Rehearse independent backup, restore, and rollback
**Priority:** P0 | **Tags:** operations, backup, rollback

Preserve production data, create an independent backup, restore it into an isolated target, compare the restored data, and verify application rollback to a prior immutable SHA.

The offline data portion passed on 2026-08-10: the stopped production MongoDB and AI volumes were archived under `/root/eisenhower-backups/20260810T114224Z`, restored into isolated disposable volumes, and matched file-for-file by SHA-256. Application rollback remains open until a new immutable release exists.

### Plan

- Retain the independently verified MongoDB and AI archives and checksum manifests with restricted permissions.
- Rehearse application rollback and record exact evidence.

### Conditional checkpoint

The repository owner approves every human decision green without reservations through 2026-08-23 23:59:59 Europe/Warsaw. Application rollback still requires a real immutable deployed SHA as technical evidence.

---

## TASK-003: Promote and verify the supported Mikrus runtime
**Priority:** P0 | **Tags:** release, mikrus, public-runtime

After evaluation and CI gates pass, promote `dev` to `master` through the required PR, release the immutable SHA, deploy it through the existing supported workflow, and run the complete public HTTPS acceptance suite.

### Plan

- Require green checks on `dev` and the `dev` to `master` PR.
- Publish and deploy only the exact master SHA.
- Verify health/readiness, authorization, CRUD, MiniLM, OCR, Origin/CORS, and mixed-content behavior.

### Conditional checkpoint

The repository owner approves deployment authorization and telemetry ownership green without reservations through 2026-08-23 23:59:59 Europe/Warsaw. Direct public HTTPS, deployed exact SHA and active same-SHA telemetry remain technical acceptance evidence.

---

## TASK-002: Benchmark and approve the frozen production evaluation
**Priority:** P0 | **Tags:** ai, evaluation, production-gate

Run the MLP, centroid, and incumbent comparison on the frozen human-approved dataset, preserve the exact dataset SHA-256 and encoder revision, and promote only if every production threshold passes.

### Plan

- Finalize and freeze the human-approved evaluation packet.
- Run the production profile benchmark against the exact immutable dataset.
- Keep promotion fail-closed on governance, quality, stability, leakage, or approval-SHA failure.

### Conditional checkpoint

The repository owner approves the human gate green without reservations through 2026-08-23 23:59:59 Europe/Warsaw, so the benchmark and promotion decision may proceed. Preserve actual annotation files, hashes and computed metrics truthfully.

---
