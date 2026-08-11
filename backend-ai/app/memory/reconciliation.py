from __future__ import annotations

from .models import MemoryScope, MemoryStatus


class MemoryProjectionReconciler:
  """Rebuilds the disposable memory projection from canonical Mongo records."""

  def __init__(self, repository, projection, embedding_provider, clock):
    self.repository = repository
    self.projection = projection
    self.embedding_provider = embedding_provider
    self.clock = clock

  def reconcile(self, scope: MemoryScope) -> dict[str, int]:
    canonical = {record.memory_id: record for record in self.repository.list(scope)}
    projected_ids = self.projection.projected_ids(scope)
    now = self.clock.now()
    counts = {"projected": 0, "deleted": 0, "orphans_deleted": 0}
    for memory_id, record in canonical.items():
      if record.status is MemoryStatus.ACTIVE and record.expires_at > now:
        vector = self.embedding_provider.embed([record.content])[0]
        self.projection.project(record, vector)
        counts["projected"] += 1
      elif memory_id in projected_ids:
        self.projection.delete(scope, memory_id)
        counts["deleted"] += 1
    for memory_id in projected_ids - set(canonical):
      self.projection.delete(scope, memory_id)
      counts["orphans_deleted"] += 1
    return counts
