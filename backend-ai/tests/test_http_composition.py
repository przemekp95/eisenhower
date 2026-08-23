from __future__ import annotations

import inspect
import subprocess
import sys
from pathlib import Path

from app.config import Settings


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FACTORY_PARAMETERS = [
  "settings",
  "store",
  "ai_service",
  "rag_service",
  "token_verifier",
  "metrics_registry",
  "audit_sink",
  "memory_runtime",
]


def settings_for(tmp_path: Path) -> Settings:
  return Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
  )


def test_dependencies_prefer_injected_boundaries(tmp_path: Path):
  from app.http.composition import build_dependencies

  class Metrics:
    def __init__(self):
      self.release_sha = None

    def set_release_sha(self, release_sha: str):
      self.release_sha = release_sha

  settings = settings_for(tmp_path)
  store = object()
  ai_service = object()
  rag_service = object()
  verifier = object()
  metrics = Metrics()
  audit = object()
  memory = object()

  dependencies = build_dependencies(
    settings=settings,
    store=store,
    ai_service=ai_service,
    rag_service=rag_service,
    token_verifier=verifier,
    metrics_registry=metrics,
    audit_sink=audit,
    memory_runtime=memory,
  )

  assert list(inspect.signature(build_dependencies).parameters) == FACTORY_PARAMETERS
  assert dependencies.settings is settings
  assert dependencies.store is store
  assert dependencies.ai_service is ai_service
  assert dependencies.rag_service is rag_service
  assert dependencies.token_verifier is verifier
  assert dependencies.metrics_registry is metrics
  assert metrics.release_sha == settings.release_sha
  assert dependencies.audit_sink is audit
  assert dependencies.memory_runtime is memory
  assert dependencies.internal_verifier is None
  assert dependencies.webhook_verifier is None
  assert dependencies.job_queue is None
  assert dependencies.response_canary_router is None
  assert settings.model_cache_dir.is_dir()


def test_schema_constraints_and_legacy_exports_are_preserved():
  from pydantic import ValidationError

  import app.main as app_main
  from app.http.schemas import InternalExtractionJobRequest, RagAnalyzeRequest

  assert app_main.RagAnalyzeRequest is RagAnalyzeRequest
  request = RagAnalyzeRequest(task="analyze", language="pl")
  assert request.model_dump() == {
    "task": "analyze",
    "language": "pl",
    "known_state": None,
    "previous_output_statements": None,
    "freshness_requirement": "snapshot_sufficient",
  }

  try:
    InternalExtractionJobRequest.model_validate({
      "event_id": "event-1",
      "tenant_id": "tenant-a",
      "source": "document.pdf",
      "scope": {
        "tenant_id": "tenant-b",
        "user_id": "user-a",
        "project_ids": [],
        "roles": [],
      },
      "source_sequence": 1,
    })
  except ValidationError as error:
    assert "envelope tenant does not match access scope" in str(error)
  else:
    raise AssertionError("tenant mismatch must remain invalid")


def test_http_composition_import_does_not_load_provider_implementations():
  source = """
import sys
from pathlib import Path
from app.config import Settings
from app.http.composition import build_dependencies
class Metrics:
  def set_release_sha(self, _release_sha): pass
settings = Settings(training_data_path=Path('/tmp/unused-training.json'), model_cache_dir=Path('/tmp'))
boundary = object()
build_dependencies(
  settings=settings,
  store=boundary,
  ai_service=boundary,
  rag_service=boundary,
  token_verifier=boundary,
  metrics_registry=Metrics(),
  audit_sink=boundary,
  memory_runtime=boundary,
)
forbidden = {
  'app.local_model', 'app.service', 'app.rag.bootstrap', 'app.memory.runtime',
  'app.jobs', 'app.webhooks', 'app.ops.response_canary',
}
assert not (forbidden & set(sys.modules)), forbidden & set(sys.modules)
"""
  completed = subprocess.run(
    [
      sys.executable,
      "-c",
      source,
    ],
    cwd=PROJECT_ROOT,
    check=False,
    capture_output=True,
    text=True,
  )

  assert completed.returncode == 0, completed.stderr
