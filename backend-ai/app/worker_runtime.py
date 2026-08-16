from __future__ import annotations

from datetime import datetime, timedelta, timezone
from os import getpid
from pathlib import Path
import json
from signal import SIGINT, SIGTERM, signal
from socket import gethostname
from threading import Event
from time import monotonic

from .config import load_settings
from .document_extraction.adapters import (
  IsolatedDocumentExtractor,
  build_governed_document_extractor,
)
from .document_extraction.application import ApprovedDocumentIngestionApplication
from .document_extraction.inspection import LocalDocumentInspector
from .document_extraction.policy import FrozenManifestExtractionPolicy
from .job_worker import JobWorker
from .jobs import SqliteJobQueue
from .rag.bootstrap import build_ingestion_application, build_rag_service
from .rag.corpus_manifest import CorpusManifest, RepositoryCorpusConnector
from .rag.golden_runner import RepositoryEvaluationHandler
from .rag.job_handlers import RagJobHandlers
from .rag.reindex import RepositoryReindexHandler
from .service import QuadrantAIService
from .runtime_limits import configure_torch_threads
from .store import TrainingStore


QUEUE_MAINTENANCE_INTERVAL_SECONDS = 60.0
TERMINAL_JOB_RETENTION = timedelta(days=7)
WORKER_HEARTBEAT_RETENTION = timedelta(days=1)
QUEUE_MAINTENANCE_BATCH_SIZE = 1000


def _maintain_queue(queue, *, now: datetime | None = None) -> None:
  current = now or datetime.now(timezone.utc)
  queue.prune_terminal_jobs(
    before=current - TERMINAL_JOB_RETENTION,
    limit=QUEUE_MAINTENANCE_BATCH_SIZE,
  )
  queue.prune_stale_worker_heartbeats(
    before=current - WORKER_HEARTBEAT_RETENTION,
    limit=QUEUE_MAINTENANCE_BATCH_SIZE,
  )


def build_worker():
  configure_torch_threads()
  settings = load_settings()
  store = TrainingStore(settings.training_data_path)
  ai_service = QuadrantAIService(settings=settings, store=store)
  ingestion = build_ingestion_application(settings, ai_service)
  if settings.corpus_repository_root is None or settings.corpus_manifest_path is None:
    raise ValueError("CORPUS_REPOSITORY_ROOT and CORPUS_MANIFEST_PATH are required for the RAG worker")
  connector = RepositoryCorpusConnector(
    settings.corpus_repository_root,
    CorpusManifest.load(settings.corpus_manifest_path),
  )
  manifest = json.loads(settings.corpus_manifest_path.read_text(encoding="utf-8"))
  extraction = ApprovedDocumentIngestionApplication(
    LocalDocumentInspector(),
    FrozenManifestExtractionPolicy.from_manifest(
      settings.corpus_repository_root,
      manifest,
    ),
    IsolatedDocumentExtractor(build_governed_document_extractor),
    ingestion,
  )
  reindex_handler = RepositoryReindexHandler(
    connector,
    ingestion,
    owner_id=settings.corpus_owner_id,
    allowed_projects=settings.corpus_allowed_projects,
  )
  backend_dir = Path(__file__).resolve().parent.parent
  evaluation_handler = RepositoryEvaluationHandler(
    service_factory=lambda: build_rag_service(settings, ai_service),
    datasets={"golden-synthetic-v1": backend_dir / "evaluation" / "golden-v1.jsonl"},
    output_dir=settings.model_cache_dir / "evaluations",
  )
  handlers = RagJobHandlers(
    ingestion,
    None,
    chunking_version=settings.chunking_version,
    reindex_project=reindex_handler,
    evaluate=evaluation_handler,
    extract_document=extraction,
  )
  queue = SqliteJobQueue(
    settings.jobs_database_path,
    max_queued_jobs=settings.jobs_max_queued,
  )
  return JobWorker(queue, handlers.registry)


def main() -> None:
  worker = build_worker()
  stopped = Event()
  signal(SIGTERM, lambda *_: stopped.set())
  signal(SIGINT, lambda *_: stopped.set())
  worker_id = f"{gethostname()}-{getpid()}"
  maintenance_due = 0.0
  while not stopped.is_set():
    current_monotonic = monotonic()
    if current_monotonic >= maintenance_due:
      _maintain_queue(worker.queue)
      maintenance_due = current_monotonic + QUEUE_MAINTENANCE_INTERVAL_SECONDS
    worker.queue.record_worker_heartbeat(worker_id)
    if not worker.run_once(worker_id=worker_id):
      stopped.wait(1.0)


if __name__ == "__main__":
  main()
