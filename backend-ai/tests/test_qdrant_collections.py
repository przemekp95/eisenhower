from app.rag.collections import QdrantCollectionManager


class Client:
  def __init__(self):
    self.created = None
    self.indexes = []
    self.alias_actions = None
    self.aliases = []

  def collection_exists(self, name):
    return False

  def create_collection(self, **kwargs):
    self.created = kwargs

  def create_payload_index(self, **kwargs):
    self.indexes.append(kwargs)

  def update_collection_aliases(self, change_aliases_operations):
    self.alias_actions = change_aliases_operations

  def get_aliases(self):
    return type("Aliases", (), {"aliases": self.aliases})()


def test_versioned_collection_has_acl_indexes_and_atomic_alias_switch():
  client = Client()
  manager = QdrantCollectionManager(client, alias="knowledge-active", vector_size=384)

  manager.create_version("knowledge-minilm-v2")
  manager.activate("knowledge-minilm-v2", previous_collection="knowledge-minilm-v1")

  assert client.created["collection_name"] == "knowledge-minilm-v2"
  assert {item["field_name"] for item in client.indexes} >= {
    "tenant_id",
    "project_id",
    "owner_id",
    "acl_subjects",
    "embedding_version",
    "document_id",
    "deleted",
  }
  actions = repr(client.alias_actions)
  assert "knowledge-active" in actions
  assert "knowledge-minilm-v2" in actions


def test_collection_manager_initializes_missing_alias_without_replacing_existing():
  client = Client()
  manager = QdrantCollectionManager(client, alias="knowledge-active", vector_size=384)

  assert manager.ensure_active("knowledge-minilm-v1") == "knowledge-minilm-v1"
  assert client.created["collection_name"] == "knowledge-minilm-v1"
  first_alias_actions = client.alias_actions

  client.aliases = [
    type("Alias", (), {"alias_name": "knowledge-active", "collection_name": "existing"})()
  ]
  assert manager.ensure_active("knowledge-minilm-v2") == "existing"
  assert client.alias_actions is first_alias_actions
