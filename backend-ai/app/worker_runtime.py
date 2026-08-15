from __future__ import annotations

from os import getpid
from pathlib import Path
from signal import SIGINT, SIGTERM, signal
from socket import gethostname
from threading import Event

from .config import load_settings
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
  while not stopped.is_set():
    worker.queue.record_worker_heartbeat(worker_id)
    if not worker.run_once(worker_id=worker_id):
      stopped.wait(1.0)


if __name__ == "__main__":
  main()
