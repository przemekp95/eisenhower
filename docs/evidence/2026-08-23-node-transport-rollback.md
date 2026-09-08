# Node transport rollback rehearsal

Generated: 2026-08-23T15:00:15.923Z

Baseline SHA: `5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9`

Candidate SHA: `18723feedccd5dcfac3e9704d97d539ac6a3e438`

Shared database URI: `mongodb://127.0.0.1:33577/rollback_transport?replicaSet=testset`

Migration commands: `none`

Sequence: `Nest -> Express -> Nest`; processes were never concurrent.

Nest initial exit: `0`

Express rollback exit: `0`

Nest restored exit: `0`

Task revision before rollback: `1`

Task revision written by Express: `2`

Task revision after restore: `2`

Idempotency replay across all phases: `passed`

Calendar binding across all phases: `passed`

Outbox lease survived rollback: `passed`

Outbox reconciliation after restore: `delivered`

No collection rewrite, schema transformation, import/export or destructive database command was run. The URI points only to an ephemeral local replica set and contains no credentials.

Overall exit: `0`
