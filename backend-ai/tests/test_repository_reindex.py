from app.rag.models import AccessScope
from app.rag.reindex import RepositoryReindexHandler
from types import SimpleNamespace


class Connector:
  def __init__(self):
    self.scopes = []
    self.manifest = SimpleNamespace(
      manifest_version="corpus-v1",
      artifact_checksum="sha256:" + ("a" * 64),
      identity_and_acl=SimpleNamespace(initial_tenant="tenant-1"),
    )

  def load_initial(self, scope):
    self.scopes.append(scope)
    return ["document"]

  def load_incremental_markdown(self, scope, *, source_sequence):
    assert scope == self.scopes[-1]
    assert source_sequence == 7
    return ["task-document"]


class Ingestion:
  def __init__(self):
    self.documents = []
    self.reindexed = []
    self.reconciled = []

  def ingest(self, documents):
    self.documents.extend(documents)
    return {"accepted": len(documents)}

  def reconcile(self, tenant_id, project_id):
    self.reconciled.append((tenant_id, project_id))
    return {"projected": 0, "pending": 0, "drifted": 0}

  def reindex_project(self, tenant_id, project_id):
    self.reindexed.append((tenant_id, project_id))
    return {"documents": 1, "projected": 1, "pending": 0}


def test_repository_reindex_uses_job_scope_and_reconciles_pending_projection():
  connector = Connector()
  ingestion = Ingestion()
  handler = RepositoryReindexHandler(
    connector,
    ingestion,
    owner_id="repository-owner",
    allowed_projects=("project-1",),
  )

  result = handler({
    "tenant_id": "tenant-1",
    "project_id": "project-1",
    "source_version": "corpus-v1",
    "content_checksum": "sha256:" + ("a" * 64),
    "source_sequence": 7,
  })

  assert connector.scopes == [AccessScope(tenant_id="tenant-1", user_id="repository-owner", project_ids=["project-1"])]
  assert ingestion.documents == ["document", "task-document"]
  assert ingestion.reindexed == [("tenant-1", "project-1")]
  assert ingestion.reconciled == [("tenant-1", "project-1")]
  assert result == {
    "ingestion": {"accepted": 2},
    "reindex": {"documents": 1, "projected": 1, "pending": 0},
    "reconciliation": {"projected": 0, "pending": 0, "drifted": 0},
  }


def test_repository_reindex_rejects_payload_scope_or_manifest_drift():
  connector = Connector()
  handler = RepositoryReindexHandler(
    connector,
    Ingestion(),
    owner_id="repository-owner",
    allowed_projects=("project-1",),
  )
  valid = {
    "tenant_id": "tenant-1",
    "project_id": "project-1",
    "source_version": "corpus-v1",
    "content_checksum": "sha256:" + ("a" * 64),
    "source_sequence": 7,
  }

  for override in (
    {"tenant_id": "tenant-2"},
    {"project_id": "project-2"},
    {"source_version": "corpus-v2"},
    {"content_checksum": "sha256:" + ("b" * 64)},
  ):
    payload = {**valid, **override}
    try:
      handler(payload)
    except Exception as error:
      assert "reindex" in str(error)
    else:
      raise AssertionError(f"reindex accepted drift: {override}")
