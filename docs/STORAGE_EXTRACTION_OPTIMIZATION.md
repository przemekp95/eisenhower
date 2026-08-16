# Storage and document-extraction optimization

## Evidence boundary

This change is verified in source, automated tests, rendered Compose configuration and an isolated local runtime. It has not been deployed, merged, exercised with production traffic or accepted against representative private documents. The extraction benchmark uses only the frozen synthetic corpus fixtures.

## Runtime shape

- MongoDB remains canonical for tasks, calendar state, RAG documents and governed memory. Query-aligned compound indexes remove the observed blocking canonical pending-document sort and cover lifecycle/calendar list and conflict queries.
- Node/Mongoose and Python/PyMongo clients use bounded pools and timeouts: pool maximum 20, 5 s connection/server-selection timeout, 10 s socket timeout and 30 s idle lifetime.
- Local and Mikrus MongoDB use a 0.25 GiB WiredTiger cache, 1 GiB container memory, 1 CPU and 512 PID limit by default. These are small-host defaults and must be re-qualified before raising workload or dataset size.
- The FastAPI producer and `rag-worker` mount the same `rag_jobs` volume at `/app/data` and use `/app/data/jobs.sqlite3`. A worker heartbeat plus queue depth by bounded job type/status is exposed through the existing private metrics endpoint.
- SQLite queue, webhook replay and document-version connections use WAL, `synchronous=FULL`, a 5 s busy timeout and a 1000-page auto-checkpoint. Queue claim and cleanup paths use partial/query-aligned indexes.
- Terminal queue payloads older than seven days are compacted in bounded batches to content-free receipts, retaining idempotency and terminal outcome. Worker heartbeats older than one day are pruned in bounded batches. Webhook replay cleanup is also bounded and indexed.
- `rag.extract_document` is a strict, signed, idempotent internal command. Its top-level tenant must equal its `AccessScope` tenant before it can enter the queue.
- The worker composes manifest inspection and policy authorization before parsing. Docling is primary; Unstructured is used only for the approved empty-primary or unsupported-layout cases and must pass a minimum-text quality gate.
- Parsing runs in a reusable spawned child. The parent enforces wall time and monitors Linux RSS every 50 ms, kills an over-budget child and checks child-reported peak RSS before accepting a result. The outer worker container provides the hard 5 GiB cgroup ceiling. `RLIMIT_AS` is intentionally not used because PyTorch reserves substantially more virtual address space than its resident set.

## Local verification snapshot (2026-08-16)

- Backend AI: 669 passed, 10 skipped, 88.48% coverage.
- Backend Node: 245 passed; TypeScript typecheck passed.
- Repository verification completed all gates: production dependency audits; API client 23/23; MCP 50/50; Node 245/245 at 100% coverage; BDD 21/21; web 187/187 plus 2 integrations at 100% coverage; backend AI 669 passed/10 skipped at 88.48%; mobile 192/192; builds and typechecks; Pylint 10.00/10. The long aggregate command received a harness SIGTERM only after Pylint printed 10.00/10, so the lint target was rerun separately and exited 0.
- Local production-contract tests: 25 passed. Node deployment tests: 10 passed.
- Producer-to-worker SQLite rehearsal: signed extraction command accepted, claimed from the same database and completed.
- SQLite growth smoke: 50,000 queued rows; oldest eligible claim 8.026 ms; compacting 1,000 terminal rows 9.482 ms. This is a single local run, not a capacity guarantee.
- Isolated MongoDB 7.0 runtime: the canonical project-pending query used `canonical_pending_by_project` with `IXSCAN` and no blocking sort; the driver pool maximum was 20; WiredTiger reported a 268,435,456-byte cache.
- Extraction benchmark v2 with one cold and one warm run per case: 11 cases, all expected phrases present, maximum observed p95 6.678866 s and maximum child peak RSS 1,264,267,264 bytes. With one sample per mode, p95 equals that sample and is smoke evidence only.
- A real governed Docling extraction completed twice in the same monitored child, and a deliberate 512 MiB allocation was killed against a 128 MiB RSS cap.

## Operational notes

- Keep a single writer worker for this SQLite deployment. Horizontal worker scaling requires moving the queue to a server-backed broker and is outside this change.
- MongoDB TTL deletion is asynchronous. An expired active memory may continue to hold its unique conflict key until the TTL monitor removes it.
- Existing memory records created by older code stored expiration timestamps as strings and are not eligible for MongoDB TTL deletion. The inspected local database contained zero memory records, so no migration was needed there. Any other environment must count BSON string/date types and migrate strings to BSON dates before enabling TTL expectations.
- Do not interpret rendered Compose, synthetic benchmarks or isolated containers as deployment or production evidence.
