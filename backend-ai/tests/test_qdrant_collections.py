from app.rag.collections import QdrantCollectionManager


class Client:
  def __init__(self):
    self.created = None
    self.indexes = []
    self.alias_actions = None
    self.aliases = []
    self.collections = set()

  def collection_exists(self, name):
    return name in self.collections

  def create_collection(self, **kwargs):
    self.created = kwargs
    self.collections.add(kwargs["collection_name"])

  def create_payload_index(self, **kwargs):
    self.indexes.append(kwargs)

  def update_collection_aliases(self, change_aliases_operations):
    self.alias_actions = change_aliases_operations
    target = next(
      (
        operation.create_alias.collection_name
        for operation in change_aliases_operations
        if getattr(operation, "create_alias", None) is not None
      ),
      None,
    )
    if target is not None:
      self.aliases = [
        type("Alias", (), {"alias_name": "knowledge-active", "collection_name": target})()
      ]

  def get_aliases(self):
    return type("Aliases", (), {"aliases": self.aliases})()


def test_versioned_collection_has_acl_indexes_and_atomic_alias_switch():
  client = Client()
  manager = QdrantCollectionManager(client, alias="knowledge-active", vector_size=384)

  manager.create_version("knowledge-minilm-v2")
  client.collections.add("knowledge-minilm-v1")
  client.aliases = [
    type("Alias", (), {
      "alias_name": "knowledge-active",
      "collection_name": "knowledge-minilm-v1",
    })()
  ]
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


def test_alias_switch_rejects_missing_target_or_unexpected_active_version():
  client = Client()
  client.collections.update({"knowledge-v1", "knowledge-v2"})
  client.aliases = [
    type("Alias", (), {"alias_name": "knowledge-active", "collection_name": "knowledge-v1"})()
  ]
  manager = QdrantCollectionManager(client, alias="knowledge-active", vector_size=384)

  try:
    manager.activate("missing", previous_collection="knowledge-v1")
    raise AssertionError("missing collection must be rejected")
  except ValueError as error:
    assert str(error) == "Target collection does not exist"

  try:
    manager.activate("knowledge-v2", previous_collection="stale-expectation")
    raise AssertionError("stale alias expectation must be rejected")
  except ValueError as error:
    assert "expected previous" in str(error)
