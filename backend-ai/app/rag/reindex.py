from __future__ import annotations

from ..job_worker import PermanentJobError
from .models import AccessScope


class RepositoryReindexHandler:
  def __init__(self, connector, ingestion_application, *, owner_id: str, allowed_projects: tuple[str, ...]):
    self.connector = connector
    self.ingestion = ingestion_application
    self.owner_id = owner_id
    self.allowed_projects = frozenset(allowed_projects)

  def __call__(self, payload: dict) -> dict:
    tenant_id = str(payload.get("tenant_id") or "")
    project_id = str(payload.get("project_id") or "")
    if not tenant_id or not project_id:
      raise PermanentJobError("repository reindex requires tenant_id and project_id")
    manifest = self.connector.manifest
    if tenant_id != manifest.identity_and_acl.initial_tenant:
      raise PermanentJobError("repository reindex tenant is outside the approved manifest")
    if project_id not in self.allowed_projects:
      raise PermanentJobError("repository reindex project is outside the approved scope")
    if payload.get("source_version") != manifest.manifest_version:
      raise PermanentJobError("repository reindex manifest version mismatch")
    if payload.get("content_checksum") != manifest.artifact_checksum:
      raise PermanentJobError("repository reindex manifest checksum mismatch")
    source_sequence = payload.get("source_sequence")
    if isinstance(source_sequence, bool) or not isinstance(source_sequence, int) or source_sequence < 1:
      raise PermanentJobError("repository reindex requires a positive source_sequence")
    scope = AccessScope(
      tenant_id=tenant_id,
      user_id=self.owner_id,
      project_ids=[project_id],
    )
    documents = self.connector.load_initial(scope)
    documents.extend(
      self.connector.load_incremental_markdown(
        scope,
        source_sequence=source_sequence,
      )
    )
    ingestion_result = self.ingestion.ingest(documents)
    reindex_result = self.ingestion.reindex_project(tenant_id, project_id)
    reconciliation_result = self.ingestion.reconcile(tenant_id, project_id)
    return {
      "ingestion": ingestion_result,
      "reindex": reindex_result,
      "reconciliation": reconciliation_result,
    }
