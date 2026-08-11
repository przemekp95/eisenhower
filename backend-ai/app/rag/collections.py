from __future__ import annotations

from dataclasses import dataclass
from typing import BinaryIO

from qdrant_client import models as qmodels


@dataclass(frozen=True)
class SnapshotArtifact:
  collection_name: str
  name: str
  checksum: str
  size_bytes: int
  created_at: str


class QdrantCollectionManager:
  def __init__(self, client, *, alias: str, vector_size: int):
    self.client = client
    self.alias = alias
    self.vector_size = vector_size

  def create_version(self, collection_name: str) -> None:
    if self.client.collection_exists(collection_name):
      raise ValueError("Versioned collection already exists")
    self.client.create_collection(
      collection_name=collection_name,
      vectors_config=qmodels.VectorParams(
        size=self.vector_size,
        distance=qmodels.Distance.COSINE,
      ),
    )
    keyword_fields = [
      "tenant_id",
      "project_id",
      "owner_id",
      "acl_subjects",
      "embedding_version",
      "document_id",
      "source_type",
    ]
    for field_name in keyword_fields:
      self.client.create_payload_index(
        collection_name=collection_name,
        field_name=field_name,
        field_schema=qmodels.PayloadSchemaType.KEYWORD,
        wait=True,
      )
    self.client.create_payload_index(
      collection_name=collection_name,
      field_name="deleted",
      field_schema=qmodels.PayloadSchemaType.BOOL,
      wait=True,
    )

  def ensure_active(self, initial_collection_name: str) -> str:
    """Create the first version only; never silently replace an active alias."""
    active = self.active_collection()
    if active is not None:
      return active
    if not self.client.collection_exists(initial_collection_name):
      self.create_version(initial_collection_name)
    self.activate(initial_collection_name, previous_collection=None)
    return initial_collection_name

  def activate(self, collection_name: str, *, previous_collection: str | None) -> None:
    if not self.client.collection_exists(collection_name):
      raise ValueError("Target collection does not exist")
    active = self.active_collection()
    if active != previous_collection:
      raise ValueError("Active alias does not match the expected previous collection")
    operations = []
    if previous_collection:
      operations.append(
        qmodels.DeleteAliasOperation(delete_alias=qmodels.DeleteAlias(alias_name=self.alias))
      )
    operations.append(
      qmodels.CreateAliasOperation(
        create_alias=qmodels.CreateAlias(
          collection_name=collection_name,
          alias_name=self.alias,
        )
      )
    )
    self.client.update_collection_aliases(change_aliases_operations=operations)
    if self.active_collection() != collection_name:
      raise RuntimeError("Qdrant alias switch did not reach the requested collection")

  def active_collection(self) -> str | None:
    matches = [
      str(alias.collection_name)
      for alias in self.client.get_aliases().aliases
      if alias.alias_name == self.alias
    ]
    if len(matches) > 1:
      raise RuntimeError("Qdrant returned duplicate active aliases")
    return matches[0] if matches else None

  def create_snapshot(self, collection_name: str) -> SnapshotArtifact:
    if not self.client.collection_exists(collection_name):
      raise ValueError("Snapshot source collection does not exist")
    snapshot = self.client.create_snapshot(collection_name=collection_name, wait=True)
    if snapshot is None or not snapshot.name or not snapshot.checksum:
      raise RuntimeError("Qdrant did not return immutable snapshot metadata")
    return SnapshotArtifact(
      collection_name=collection_name,
      name=str(snapshot.name),
      checksum=str(snapshot.checksum),
      size_bytes=int(snapshot.size or 0),
      created_at=str(snapshot.creation_time or ""),
    )

  def restore_uploaded_snapshot(
    self,
    collection_name: str,
    snapshot: BinaryIO,
    *,
    checksum: str,
  ) -> None:
    if self.client.collection_exists(collection_name):
      raise ValueError("Snapshot restore target already exists")
    response = self.client.http.snapshots_api.recover_from_uploaded_snapshot(
      collection_name=collection_name,
      wait=True,
      priority=qmodels.SnapshotPriority.SNAPSHOT,
      checksum=checksum,
      snapshot=snapshot,
    )
    if response.result is not True or not self.client.collection_exists(collection_name):
      raise RuntimeError("Qdrant snapshot restore did not complete")

  def delete_snapshot(self, artifact: SnapshotArtifact) -> None:
    result = self.client.delete_snapshot(
      collection_name=artifact.collection_name,
      snapshot_name=artifact.name,
      wait=True,
    )
    if result is not True:
      raise RuntimeError("Qdrant snapshot cleanup did not complete")
