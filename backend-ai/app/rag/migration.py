from __future__ import annotations

from uuid import uuid4

from app.audit import AuditAction, AuditError, AuditEvent, AuditOutcome

from .collections import QdrantCollectionManager
from .errors import ProjectionUnavailable
from .ports import ChunkingEngine, EmbeddingProvider, IngestionPort


class CandidateBackfillApplication:
  """Rebuild a candidate projection from Mongo without changing canonical state."""

  def __init__(
    self,
    embedding_provider: EmbeddingProvider,
    canonical_store,
    candidate_projection: IngestionPort,
    chunking_engine: ChunkingEngine,
  ):
    self.embedding_provider = embedding_provider
    self.canonical_store = canonical_store
    self.candidate_projection = candidate_projection
    self.chunking_engine = chunking_engine

  def run(self, tenant_id: str, project_id: str | None = None) -> dict[str, int]:
    documents = self.canonical_store.project_documents(tenant_id, project_id)
    projected = 0
    failed = 0
    tombstoned = 0
    for document in documents:
      try:
        if document.deleted:
          self.candidate_projection.tombstone(
            document.document_id,
            document.tenant_id,
            document.content_version,
            source_sequence=document.source_sequence,
          )
          tombstoned += 1
        else:
          chunks = self.chunking_engine.build(
            document,
            embedding_version=self.embedding_provider.version,
          )
          vectors = self.embedding_provider.embed([chunk.text for chunk in chunks]) if chunks else []
          self.candidate_projection.replace_documents([document], chunks, vectors)
          projected += 1
      except ProjectionUnavailable:
        failed += 1
    return {
      "documents": len(documents),
      "projected": projected,
      "failed": failed,
      "tombstoned": tombstoned,
    }


class LlamaIndexCutoverController:
  """Guarded alias switch; both physical collections remain available for rollback."""

  def __init__(
    self,
    manager: QdrantCollectionManager,
    *,
    legacy_collection: str,
    candidate_collection: str,
  ):
    if legacy_collection == candidate_collection:
      raise ValueError("legacy and candidate collections must differ")
    self.manager = manager
    self.legacy_collection = legacy_collection
    self.candidate_collection = candidate_collection

  def preflight(self, action: str) -> dict[str, str]:
    if action not in {"cutover", "rollback"}:
      raise ValueError("action must be cutover or rollback")
    source = self.legacy_collection if action == "cutover" else self.candidate_collection
    target = self.candidate_collection if action == "cutover" else self.legacy_collection
    if not self.manager.client.collection_exists(target):
      raise ValueError("Target collection does not exist")
    active = self.manager.active_collection()
    if active != source:
      raise ValueError("Active alias does not match the expected previous collection")
    return {"active_collection": source, "target_collection": target}

  def cutover(self) -> dict[str, str]:
    self.preflight("cutover")
    self.manager.activate(
      self.candidate_collection,
      previous_collection=self.legacy_collection,
    )
    return {
      "previous_collection": self.legacy_collection,
      "active_collection": self.candidate_collection,
    }

  def rollback(self) -> dict[str, str]:
    self.preflight("rollback")
    self.manager.activate(
      self.legacy_collection,
      previous_collection=self.candidate_collection,
    )
    return {
      "previous_collection": self.candidate_collection,
      "active_collection": self.legacy_collection,
    }

  def apply_audited(
    self,
    action: str,
    *,
    audit_sink,
    release_sha: str,
    actor_id: str,
    request_id: str,
  ) -> dict[str, str]:
    """Apply an alias transition only with durable attempt/result evidence."""
    self.preflight(action)
    audit_action = (
      AuditAction.ROLLOUT_DECISION if action == "cutover" else AuditAction.ROLLBACK_DECISION
    )
    resource = f"llamaindex-alias-{action}"
    self._record_audit(
      audit_sink, release_sha, actor_id, request_id,
      action=audit_action, outcome=AuditOutcome.ATTEMPT, resource_id=f"{resource}:attempt",
    )
    try:
      transition = self.cutover() if action == "cutover" else self.rollback()
    except Exception:
      self._compensate_if_switched(action)
      self._record_audit(
        audit_sink, release_sha, actor_id, request_id,
        action=audit_action, outcome=AuditOutcome.ERROR, resource_id=f"{resource}:result",
      )
      raise
    try:
      self._record_audit(
        audit_sink, release_sha, actor_id, request_id,
        action=audit_action, outcome=AuditOutcome.SUCCESS, resource_id=f"{resource}:result",
      )
    except RuntimeError:
      self._compensate_if_switched(action)
      raise
    return transition

  def _compensate_if_switched(self, action: str) -> None:
    target = self.candidate_collection if action == "cutover" else self.legacy_collection
    if self.manager.active_collection() != target:
      return
    if action == "cutover":
      self.rollback()
    else:
      self.cutover()

  @staticmethod
  def _record_audit(
    audit_sink,
    release_sha: str,
    actor_id: str,
    request_id: str,
    *,
    action: AuditAction,
    outcome: AuditOutcome,
    resource_id: str,
  ) -> None:
    try:
      audit_sink.record(AuditEvent(
        service="rag-cutover",
        release_sha=release_sha,
        event_id=f"rag-cutover-{uuid4().hex}",
        request_id=request_id,
        action=action,
        outcome=outcome,
        tenant_id="deployment",
        actor_id=actor_id,
        resource_id=resource_id,
      ))
    except (AuditError, TypeError, ValueError) as issue:
      raise RuntimeError("durable cutover audit is unavailable") from issue
