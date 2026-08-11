from __future__ import annotations

import argparse
from hashlib import sha256
from importlib.metadata import version
from io import BytesIO
import json
from pathlib import Path
from time import perf_counter
from uuid import NAMESPACE_URL, uuid4, uuid5

import httpx
from qdrant_client import QdrantClient, models as qmodels

from app.rag.adapters import QdrantIngestionAdapter, QdrantRetriever
from app.rag.collections import QdrantCollectionManager
from app.rag.ingestion import DeterministicChunker, build_chunk_records
from app.rag.models import AccessScope, RetrievalQuery, SourceDocument


QDRANT_URL = "http://127.0.0.1:6333"
EMBEDDING_VERSION = "task012-runtime-v1"


class ConstantEmbedding:
  version = EMBEDDING_VERSION

  @staticmethod
  def embed(texts):
    return [[1.0, 0.0, 0.0] for _text in texts]


def _point(chunk_id: str, *, tenant: str, project: str, acl: list[str], deleted=False):
  return qmodels.PointStruct(
    id=str(uuid5(NAMESPACE_URL, chunk_id)),
    vector=[1.0, 0.0, 0.0],
    payload={
      "chunk_id": chunk_id,
      "document_id": f"document-{chunk_id}",
      "tenant_id": tenant,
      "project_id": project,
      "owner_id": acl[0],
      "source_type": "project_context",
      "source_uri": f"eisenhower://task012/{chunk_id}",
      "title": chunk_id,
      "text": f"runtime evidence {chunk_id}",
      "position": 0,
      "checksum": sha256(chunk_id.encode()).hexdigest(),
      "content_version": "v1",
      "embedding_version": EMBEDDING_VERSION,
      "acl_subjects": acl,
      "deleted": deleted,
    },
  )


def _all_points(client, collection_name: str):
  points = []
  offset = None
  while True:
    page, next_offset = client.scroll(
      collection_name=collection_name,
      limit=100,
      offset=offset,
      with_payload=True,
      with_vectors=True,
    )
    points.extend(page)
    if next_offset is None:
      return points
    offset = next_offset


def _digest(points) -> str:
  records = [
    {
      "id": str(point.id),
      "payload": point.payload,
      "vector": point.vector,
    }
    for point in points
  ]
  records.sort(key=lambda item: item["id"])
  return sha256(
    json.dumps(records, sort_keys=True, separators=(",", ":")).encode()
  ).hexdigest()


def _hit_ids(retriever, *, tenant: str, user: str, project: str) -> list[str]:
  hits = retriever.retrieve(RetrievalQuery(
    text="runtime evidence",
    scope=AccessScope(tenant_id=tenant, user_id=user, project_ids=[project]),
    project_id=project,
    limit=20,
    score_threshold=-1,
  ))
  return sorted(hit.chunk_id for hit in hits)


def run_verification(snapshot_output: Path | None = None) -> dict:
  suffix = uuid4().hex
  source = f"task012_source_{suffix}"
  restored = f"task012_restored_{suffix}"
  alias = f"task012_active_{suffix}"
  client = QdrantClient(url=QDRANT_URL, timeout=20)
  manager = QdrantCollectionManager(client, alias=alias, vector_size=3)
  artifact = None
  cleanup = {"snapshot_deleted": False, "collections_deleted": False}
  started_total = perf_counter()
  try:
    server = httpx.get(f"{QDRANT_URL}/", timeout=5).raise_for_status().json()
    manager.create_version(source)
    manager.activate(source, previous_collection=None)
    client.upsert(
      collection_name=source,
      wait=True,
      points=[
        _point("allowed", tenant="tenant-a", project="project-a", acl=["user:user-a"]),
        _point("wrong-project", tenant="tenant-a", project="project-b", acl=["user:user-a"]),
        _point("wrong-acl", tenant="tenant-a", project="project-a", acl=["role:admin"]),
        _point("cross-tenant", tenant="tenant-b", project="project-a", acl=["user:user-a"]),
        _point("delete-me", tenant="tenant-a", project="project-a", acl=["user:user-a"]),
      ],
    )
    retriever = QdrantRetriever(client, ConstantEmbedding(), collection_alias=alias)
    isolation = {
      "allowed_scope_hits": _hit_ids(
        retriever, tenant="tenant-a", user="user-a", project="project-a"
      ),
      "wrong_project_hits": _hit_ids(
        retriever, tenant="tenant-a", user="user-a", project="project-c"
      ),
      "wrong_user_hits": _hit_ids(
        retriever, tenant="tenant-a", user="user-z", project="project-a"
      ),
      "cross_tenant_hits": _hit_ids(
        retriever, tenant="tenant-z", user="user-a", project="project-a"
      ),
    }
    if isolation != {
      "allowed_scope_hits": ["allowed", "delete-me"],
      "wrong_project_hits": [],
      "wrong_user_hits": [],
      "cross_tenant_hits": [],
    }:
      raise AssertionError(f"Qdrant isolation mismatch: {isolation}")

    source_points = _all_points(client, source)
    source_digest = _digest(source_points)
    snapshot_started = perf_counter()
    artifact = manager.create_snapshot(source)
    snapshot_seconds = perf_counter() - snapshot_started
    snapshot_response = httpx.get(
      f"{QDRANT_URL}/collections/{source}/snapshots/{artifact.name}",
      timeout=30,
    )
    snapshot_response.raise_for_status()
    snapshot_bytes = snapshot_response.content
    if snapshot_output is not None:
      snapshot_output.parent.mkdir(parents=True, exist_ok=True)
      snapshot_output.write_bytes(snapshot_bytes)
    independent_sha = sha256(snapshot_bytes).hexdigest()
    if independent_sha != artifact.checksum:
      raise AssertionError("Downloaded snapshot checksum differs from Qdrant metadata")

    restore_started = perf_counter()
    manager.restore_uploaded_snapshot(
      restored,
      BytesIO(snapshot_bytes),
      checksum=artifact.checksum,
    )
    restore_seconds = perf_counter() - restore_started
    restored_points = _all_points(client, restored)
    restored_digest = _digest(restored_points)
    if restored_digest != source_digest:
      raise AssertionError("Isolated restored collection differs from snapshot source")

    source_projection = QdrantIngestionAdapter(client, collection_name=source)
    restored_projection = QdrantIngestionAdapter(client, collection_name=restored)
    for projection in (source_projection, restored_projection):
      projection.tombstone("document-delete-me", "tenant-a", "deleted-v2")
    refreshed = SourceDocument(
      document_id="document-allowed",
      tenant_id="tenant-a",
      project_id="project-a",
      owner_id="user-a",
      source_type="project_context",
      source_uri="eisenhower://task012/allowed",
      title="allowed refreshed",
      text="runtime evidence allowed refreshed version",
      content_version="v2",
      source_sequence=2,
      acl_subjects=["user:user-a"],
    )
    chunks = build_chunk_records(
      refreshed,
      DeterministicChunker(max_chars=1200, overlap_chars=160),
      embedding_version=EMBEDDING_VERSION,
    )
    restored_projection.replace_documents([refreshed], chunks, [[1.0, 0.0, 0.0]])
    restored_inventory = _all_points(client, restored)
    restored_chunk_ids = sorted(str(point.payload["chunk_id"]) for point in restored_inventory)
    expected_restored_ids = sorted([
      "wrong-project",
      "wrong-acl",
      "cross-tenant",
      chunks[0].chunk_id,
    ])
    if restored_chunk_ids != expected_restored_ids:
      raise AssertionError("Restored inventory contains stale, tombstoned or orphan points")
    source_after_tombstone_ids = sorted(
      str(point.payload["chunk_id"]) for point in _all_points(client, source)
    )
    if source_after_tombstone_ids != ["allowed", "cross-tenant", "wrong-acl", "wrong-project"]:
      raise AssertionError("Retained rollback collection has an unsafe inventory")

    cutover_started = perf_counter()
    manager.activate(restored, previous_collection=source)
    cutover_seconds = perf_counter() - cutover_started
    cutover_hits = _hit_ids(
      retriever, tenant="tenant-a", user="user-a", project="project-a"
    )
    if cutover_hits != [chunks[0].chunk_id]:
      raise AssertionError("Alias cutover did not expose exactly the refreshed projection")
    retained_previous = client.collection_exists(source)

    rollback_started = perf_counter()
    manager.activate(source, previous_collection=restored)
    rollback_seconds = perf_counter() - rollback_started
    rollback_hits = _hit_ids(
      retriever, tenant="tenant-a", user="user-a", project="project-a"
    )
    if rollback_hits != ["allowed"]:
      raise AssertionError("Alias rollback failed or resurrected tombstoned content")

    manifest_path = Path(__file__).resolve().parents[2] / "docs" / "ai-rebuild" / "corpus-manifest-v1.json"
    report = {
      "schema_version": "qdrant-recovery-local-v1",
      "evidence_level": "local-container-runtime",
      "production_recovery_proven": False,
      "manifest_sha256": sha256(manifest_path.read_bytes()).hexdigest(),
      "qdrant_server": {"version": server["version"], "commit": server["commit"]},
      "qdrant_client_version": version("qdrant-client"),
      "api_operations": [
        "create_collection",
        "create_snapshot",
        "download_snapshot",
        "recover_from_uploaded_snapshot",
        "delete_points_by_tenant_document_filter",
        "atomic_delete_create_alias_batch",
      ],
      "source": {
        "collection": source,
        "points": len(source_points),
        "digest_sha256": source_digest,
      },
      "snapshot": {
        "name": artifact.name,
        "size_bytes": artifact.size_bytes,
        "qdrant_checksum": artifact.checksum,
        "independent_download_sha256": independent_sha,
        "snapshot_seconds": round(snapshot_seconds, 6),
      },
      "restore": {
        "collection": restored,
        "points_before_mutation": len(restored_points),
        "digest_sha256": restored_digest,
        "matches_source": restored_digest == source_digest,
        "restore_seconds": round(restore_seconds, 6),
      },
      "isolation": isolation,
      "physical_removal": {
        "stale_chunk_absent": "allowed" not in restored_chunk_ids,
        "tombstoned_chunk_absent_from_source": "delete-me" not in source_after_tombstone_ids,
        "tombstoned_chunk_absent_from_restored": "delete-me" not in restored_chunk_ids,
        "orphan_points": sorted(set(restored_chunk_ids) - set(expected_restored_ids)),
      },
      "alias": {
        "cutover": [source, restored],
        "cutover_hits": cutover_hits,
        "cutover_seconds": round(cutover_seconds, 6),
        "previous_collection_retained": retained_previous,
        "rollback": [restored, source],
        "rollback_hits": rollback_hits,
        "rollback_seconds": round(rollback_seconds, 6),
        "active_after_rollback": manager.active_collection(),
      },
      "total_seconds": round(perf_counter() - started_total, 6),
      "cleanup": cleanup,
    }
    return report
  finally:
    if artifact is not None:
      existing_snapshots = {item.name for item in client.list_snapshots(source)}
      if artifact.name in existing_snapshots:
        manager.delete_snapshot(artifact)
      cleanup["snapshot_deleted"] = True
    active = manager.active_collection()
    if active in {source, restored}:
      client.update_collection_aliases(change_aliases_operations=[
        qmodels.DeleteAliasOperation(delete_alias=qmodels.DeleteAlias(alias_name=alias))
      ])
    for collection_name in (restored, source):
      if client.collection_exists(collection_name):
        client.delete_collection(collection_name=collection_name)
    cleanup["collections_deleted"] = True
    client.close()


def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument("--output", type=Path)
  parser.add_argument("--snapshot-output", type=Path)
  args = parser.parse_args()
  report = run_verification(args.snapshot_output)
  if not all(report["cleanup"].values()):
    raise RuntimeError("Qdrant verification artifacts were not cleaned up")
  if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
  print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
  main()
