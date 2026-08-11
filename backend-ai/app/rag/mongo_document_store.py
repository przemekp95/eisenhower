from __future__ import annotations

from hashlib import sha256
from typing import Any

from .canonical import CanonicalDocumentState, CanonicalWriteStatus
from .models import SourceDocument


class MongoCanonicalDocumentStore:
  """Single-collection canonical store with an atomic monotonic write boundary.

  The injected collection is expected to have PyMongo-compatible methods. This
  adapter deliberately does not claim cross-collection transaction or outbox
  guarantees: projection reconciliation is represented only by the durable
  ``projection_pending`` field in the same canonical document.
  """

  def __init__(self, collection):
    self.collection = collection
    self.collection.create_index(
      [("tenant_id", 1), ("document_id", 1)],
      unique=True,
      name="canonical_tenant_document_unique",
    )
    self.collection.create_index(
      [("tenant_id", 1), ("project_id", 1), ("projection_pending", 1)],
      name="canonical_projection_pending",
    )

  def stage(self, document: SourceDocument) -> CanonicalWriteStatus:
    candidate = self._normalized_document(document)
    persisted = candidate.model_dump(mode="json")
    persisted["projection_pending"] = True
    selector = {
      "tenant_id": candidate.tenant_id,
      "document_id": candidate.document_id,
      "$or": [
        {"source_sequence": {"$lt": candidate.source_sequence}},
        {"source_sequence": {"$exists": False}},
      ],
    }
    try:
      result = self.collection.replace_one(selector, persisted, upsert=True)
    except Exception as exc:  # PyMongo is supplied by the composition root.
      if not self._is_duplicate_key(exc):
        raise
      return self._classify_existing(candidate)
    if getattr(result, "matched_count", 0) == 1 or getattr(result, "upserted_id", None) is not None:
      return CanonicalWriteStatus.ACCEPTED
    # Defensive fallback for collection-compatible implementations that report
    # an upsert race without raising their native duplicate-key exception.
    return self._classify_existing(candidate)

  def mark_projected(self, document: SourceDocument) -> bool:
    candidate = self._normalized_document(document)
    result = self.collection.update_one(
      {
        "tenant_id": candidate.tenant_id,
        "document_id": candidate.document_id,
        "source_sequence": candidate.source_sequence,
        "content_checksum": candidate.content_checksum,
      },
      {"$set": {"projection_pending": False}},
    )
    return getattr(result, "matched_count", 0) == 1

  def pending_documents(self, tenant_id: str, project_id: str | None = None) -> list[SourceDocument]:
    selector: dict[str, Any] = {"tenant_id": tenant_id, "projection_pending": True}
    if project_id is not None:
      selector["project_id"] = project_id
    records = self.collection.find(selector, sort=[("source_sequence", 1), ("document_id", 1)])
    return [self._source_document(record) for record in records]

  def project_documents(self, tenant_id: str, project_id: str | None = None) -> list[SourceDocument]:
    selector: dict[str, Any] = {"tenant_id": tenant_id}
    if project_id is not None:
      selector["project_id"] = project_id
    records = self.collection.find(selector, sort=[("document_id", 1)])
    return [self._source_document(record) for record in records]

  def get(self, tenant_id: str, document_id: str) -> SourceDocument | None:
    record = self.collection.find_one({"tenant_id": tenant_id, "document_id": document_id})
    return self._source_document(record) if record is not None else None

  def retrieval_state(self, tenant_id: str, document_id: str) -> CanonicalDocumentState | None:
    record = self.collection.find_one({"tenant_id": tenant_id, "document_id": document_id})
    if record is None:
      return None
    return CanonicalDocumentState(
      document=self._source_document(record),
      projection_pending=record.get("projection_pending") is not False,
    )

  def _classify_existing(self, candidate: SourceDocument) -> CanonicalWriteStatus:
    current = self.collection.find_one(
      {"tenant_id": candidate.tenant_id, "document_id": candidate.document_id}
    )
    if current is None:
      raise RuntimeError("canonical write lost its unique-key conflict winner")
    current_sequence = int(current.get("source_sequence", 0))
    if candidate.source_sequence < current_sequence:
      return CanonicalWriteStatus.STALE
    if candidate.source_sequence == current_sequence:
      if candidate.content_checksum == current.get("content_checksum"):
        return CanonicalWriteStatus.DUPLICATE
      return CanonicalWriteStatus.CONFLICT
    raise RuntimeError("canonical write observed a non-monotonic race")

  @staticmethod
  def _normalized_document(document: SourceDocument) -> SourceDocument:
    if not document.deleted:
      return document
    return document.model_copy(
      update={
        "text": "",
        "title": "[deleted]",
        "content_checksum": sha256(b"").hexdigest(),
      }
    )

  @staticmethod
  def _source_document(record: dict) -> SourceDocument:
    payload = {key: value for key, value in record.items() if key not in {"_id", "projection_pending"}}
    return SourceDocument.model_validate(payload)

  @staticmethod
  def _is_duplicate_key(exc: Exception) -> bool:
    return getattr(exc, "code", None) == 11000
