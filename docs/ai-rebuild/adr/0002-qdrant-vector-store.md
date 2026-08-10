# ADR 0002: Qdrant is the single vector database

Status: accepted for this architecture; runtime unverified.

## Context and comparison

Qdrant already has repository scaffolding, native payload filters, versioned collections and collection aliases suitable for atomic cutover. PGVector would reduce the number of databases only if PostgreSQL were already the canonical operational store and team expertise/backup tooling made that consolidation valuable. This repository currently uses MongoDB for application data, so adding PostgreSQL solely for vectors creates another database without eliminating MongoDB.

## Decision

Use Qdrant only. MongoDB or another explicitly chosen document store remains canonical; Qdrant is a derived, rebuildable index. Do not implement Qdrant and PGVector in parallel.

Create payload indexes for `tenant_id`, `project_id`, `owner_id`, `acl_subjects`, `source_type`, `embedding_version`, `content_version`, and `deleted` as cardinality/query patterns justify. Retrieval must always include tenant, embedding-version, tombstone and ACL filters.

## Consequences

- Reindex into a versioned collection, validate, then atomically move the active alias.
- Retain the previous collection for the rollback window.
- Snapshot/restore, capacity, replication and durability need environment-specific runbooks.
- Qdrant content cannot become the only copy of a source document.

References: [collections and aliases](https://qdrant.tech/documentation/manage-data/collections/), [payload indexes](https://qdrant.tech/documentation/manage-data/indexing/).

## Gate

Go only after ACL-filter tests against a real Qdrant instance, index/alias migration rehearsal, snapshot restore, capacity limits and tenant leakage tests pass.
