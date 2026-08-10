from __future__ import annotations

from qdrant_client import models as qmodels


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
    aliases = self.client.get_aliases().aliases
    for alias in aliases:
      if alias.alias_name == self.alias:
        return str(alias.collection_name)
    if not self.client.collection_exists(initial_collection_name):
      self.create_version(initial_collection_name)
    self.activate(initial_collection_name, previous_collection=None)
    return initial_collection_name

  def activate(self, collection_name: str, *, previous_collection: str | None) -> None:
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
