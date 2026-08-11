from copy import deepcopy
from operator import itemgetter

from app.rag.canonical import CanonicalWriteStatus
from app.rag.models import SourceDocument
from app.rag.mongo_document_store import MongoCanonicalDocumentStore


class DuplicateKeyError(Exception):
  code = 11000


class WriteResult:
  def __init__(self, *, matched_count=0, upserted_id=None):
    self.matched_count = matched_count
    self.upserted_id = upserted_id


class FakeCollection:
  def __init__(self):
    self.documents = {}
    self.indexes = []

  def create_index(self, keys, **options):
    self.indexes.append((keys, options))

  def replace_one(self, _selector, replacement, upsert=False):
    key = (replacement["tenant_id"], replacement["document_id"])
    current = self.documents.get(key)
    sequence = replacement["source_sequence"]
    if current is not None and current["source_sequence"] < sequence:
      self.documents[key] = deepcopy(replacement)
      return WriteResult(matched_count=1)
    if current is None and upsert:
      self.documents[key] = deepcopy(replacement)
      return WriteResult(upserted_id=f"{key[0]}:{key[1]}")
    raise DuplicateKeyError()

  def find_one(self, selector):
    return deepcopy(self.documents.get((selector["tenant_id"], selector["document_id"])))

  def update_one(self, selector, update):
    key = (selector["tenant_id"], selector["document_id"])
    current = self.documents.get(key)
    if current and all(current.get(field) == value for field, value in selector.items()):
      current.update(update["$set"])
      return WriteResult(matched_count=1)
    return WriteResult()

  def find(self, selector, sort):
    matches = [
      deepcopy(document)
      for document in self.documents.values()
      if all(document.get(field) == value for field, value in selector.items())
    ]
    for field, direction in reversed(sort):
      matches.sort(key=itemgetter(field), reverse=direction < 0)
    return matches


def source_document(*, tenant="tenant-1", project="project-1", sequence=1, text="Reviewed", deleted=False):
  return SourceDocument(
    document_id="doc-1",
    tenant_id=tenant,
    project_id=project,
    owner_id="user-1",
    source_type="decision",
    source_uri="eisenhower://repository/decision.md",
    title="Decision",
    text=text,
    content_version=f"v{sequence}",
    source_sequence=sequence,
    acl_subjects=[f"tenant:{tenant}", f"project:{project}"],
    deleted=deleted,
  )


def test_store_creates_unique_identity_and_pending_lookup_indexes():
  collection = FakeCollection()
  MongoCanonicalDocumentStore(collection)

  assert collection.indexes == [
    (
      [("tenant_id", 1), ("document_id", 1)],
      {"unique": True, "name": "canonical_tenant_document_unique"},
    ),
    (
      [("tenant_id", 1), ("project_id", 1), ("projection_pending", 1)],
      {"name": "canonical_projection_pending"},
    ),
  ]


def test_stage_accepts_only_monotonic_sequence_and_classifies_replays():
  collection = FakeCollection()
  store = MongoCanonicalDocumentStore(collection)

  assert store.stage(source_document(sequence=2)) is CanonicalWriteStatus.ACCEPTED
  assert store.stage(source_document(sequence=1)) is CanonicalWriteStatus.STALE
  assert store.stage(source_document(sequence=2)) is CanonicalWriteStatus.DUPLICATE
  assert store.stage(source_document(sequence=2, text="Changed")) is CanonicalWriteStatus.CONFLICT
  assert store.stage(source_document(sequence=3, text="Changed")) is CanonicalWriteStatus.ACCEPTED

  current = collection.documents[("tenant-1", "doc-1")]
  assert current["source_sequence"] == 3
  assert current["projection_pending"] is True


def test_tombstone_redacts_content_before_it_reaches_canonical_storage():
  collection = FakeCollection()
  store = MongoCanonicalDocumentStore(collection)

  tombstone = source_document(sequence=2, text="private content", deleted=True)
  assert store.stage(tombstone) is CanonicalWriteStatus.ACCEPTED

  persisted = collection.documents[("tenant-1", "doc-1")]
  assert persisted["deleted"] is True
  assert persisted["text"] == ""
  assert persisted["title"] == "[deleted]"
  assert "private content" not in repr(persisted)
  assert store.stage(tombstone) is CanonicalWriteStatus.DUPLICATE


def test_mark_projected_only_completes_the_exact_canonical_revision():
  collection = FakeCollection()
  store = MongoCanonicalDocumentStore(collection)
  first = source_document(sequence=1)
  second = source_document(sequence=2, text="New")
  store.stage(first)
  store.stage(second)

  assert store.mark_projected(first) is False
  assert collection.documents[("tenant-1", "doc-1")]["projection_pending"] is True

  assert store.mark_projected(second) is True
  assert collection.documents[("tenant-1", "doc-1")]["projection_pending"] is False


def test_pending_documents_are_scoped_by_tenant_and_optional_project():
  collection = FakeCollection()
  store = MongoCanonicalDocumentStore(collection)
  tenant_one = source_document(tenant="tenant-1", project="project-1")
  other_project = source_document(tenant="tenant-1", project="project-2", sequence=2)
  other_project.document_id = "doc-2"
  other_tenant = source_document(tenant="tenant-2", project="project-1")
  store.stage(tenant_one)
  store.stage(other_project)
  store.stage(other_tenant)
  store.mark_projected(tenant_one)

  assert [item.document_id for item in store.pending_documents("tenant-1")] == ["doc-2"]
  assert store.pending_documents("tenant-1", "project-1") == []
  assert [item.document_id for item in store.pending_documents("tenant-1", "project-2")] == ["doc-2"]
  assert [item.tenant_id for item in store.pending_documents("tenant-2")] == ["tenant-2"]


def test_project_documents_return_all_current_records_within_scope():
  collection = FakeCollection()
  store = MongoCanonicalDocumentStore(collection)
  first = source_document(tenant="tenant-1", project="project-1")
  second = source_document(tenant="tenant-1", project="project-2", sequence=2)
  second.document_id = "doc-2"
  store.stage(first)
  store.stage(second)

  assert [item.document_id for item in store.project_documents("tenant-1", "project-1")] == ["doc-1"]
  assert [item.document_id for item in store.project_documents("tenant-1")] == ["doc-1", "doc-2"]
