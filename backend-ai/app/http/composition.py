from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
  from ..audit import AuditSink
  from ..auth import ServiceTokenVerifier, TokenVerifier
  from ..config import Settings
  from ..jobs import SqliteJobQueue
  from ..metrics import MetricsRegistry
  from ..ops.response_canary import ResponseCanaryRouter
  from ..service import QuadrantAIService
  from ..store import TrainingStore
  from ..webhooks import WebhookReplayVerifier


@dataclass(frozen=True)
class AppDependencies:
  settings: Settings
  store: TrainingStore
  ai_service: QuadrantAIService
  rag_service: object | None
  token_verifier: TokenVerifier
  internal_verifier: ServiceTokenVerifier | None
  webhook_verifier: WebhookReplayVerifier | None
  job_queue: SqliteJobQueue | None
  metrics_registry: MetricsRegistry
  audit_sink: AuditSink
  memory_runtime: object | None
  response_canary_router: ResponseCanaryRouter | None


def build_dependencies(
  settings: Settings | None = None,
  store: TrainingStore | None = None,
  ai_service: QuadrantAIService | None = None,
  rag_service: object | None = None,
  token_verifier: TokenVerifier | None = None,
  metrics_registry: MetricsRegistry | None = None,
  audit_sink: AuditSink | None = None,
  memory_runtime: object | None = None,
) -> AppDependencies:
  from ..runtime_limits import configure_torch_threads

  if settings is None:
    from ..config import load_settings

    resolved_settings = load_settings()
  else:
    resolved_settings = settings
  configure_torch_threads()
  if store is None:
    from ..store import TrainingStore

    resolved_store = TrainingStore(resolved_settings.training_data_path)
  else:
    resolved_store = store
  if ai_service is None:
    from ..service import QuadrantAIService

    resolved_ai_service = QuadrantAIService(
      settings=resolved_settings,
      store=resolved_store,
    )
  else:
    resolved_ai_service = ai_service
  resolved_rag_service = rag_service
  if resolved_rag_service is None and resolved_settings.rag_retrieval_enabled:
    from ..rag.bootstrap import build_rag_service

    resolved_rag_service = build_rag_service(resolved_settings, resolved_ai_service)
  response_canary_router = (
    _build_response_canary(resolved_settings)
    if resolved_settings.rag_response_promotion_pointer_path
    and resolved_settings.rag_response_candidate_id
    else None
  )
  resolved_settings.model_cache_dir.mkdir(parents=True, exist_ok=True)
  resolved_verifier = token_verifier
  if resolved_verifier is None:
    from ..auth import OIDCVerifier, StaticTokenVerifier

    if resolved_settings.auth_mode == "oidc":
      resolved_verifier = OIDCVerifier(
        issuer=str(resolved_settings.oidc_issuer),
        audience=str(resolved_settings.oidc_audience),
        jwks_url=resolved_settings.oidc_jwks_url,
      )
    else:
      resolved_verifier = StaticTokenVerifier(
        user_token=resolved_settings.api_token,
        admin_token=resolved_settings.admin_token,
      )
  internal_verifier = None
  webhook_verifier = None
  job_queue = None
  if resolved_settings.internal_api_token:
    from ..auth import ServiceTokenVerifier
    from ..jobs import SqliteJobQueue

    internal_verifier = ServiceTokenVerifier(
      token=resolved_settings.internal_api_token,
      service_id="n8n-ingestion",
      scopes=["rag:ingest"],
    )
    job_queue = SqliteJobQueue(
      resolved_settings.jobs_database_path,
      max_queued_jobs=resolved_settings.jobs_max_queued,
    )
  if resolved_settings.webhook_secret:
    from ..webhooks import WebhookReplayVerifier

    webhook_verifier = WebhookReplayVerifier(
      resolved_settings.model_cache_dir / "webhook-replay.sqlite3",
      secret=resolved_settings.webhook_secret,
    )
  if metrics_registry is None:
    from ..metrics import MetricsRegistry

    metrics = MetricsRegistry()
  else:
    metrics = metrics_registry
  metrics.set_release_sha(resolved_settings.release_sha)
  if audit_sink is None:
    from ..audit import SqliteAuditSink

    audit = SqliteAuditSink(
      resolved_settings.audit_database_path,
      hmac_key=resolved_settings.audit_hmac_key.encode("utf-8"),
    )
  else:
    audit = audit_sink
  resolved_memory_runtime = memory_runtime
  memory_requested = bool(
    resolved_settings.memory_write_enabled
    or resolved_settings.memory_retrieval_enabled
    or resolved_settings.memory_response_enabled
  )
  if memory_requested and resolved_memory_runtime is None:
    from ..memory.runtime import build_memory_runtime

    resolved_memory_runtime = build_memory_runtime(
      resolved_settings,
      resolved_ai_service,
      audit_sink=audit,
    )
  return AppDependencies(
    settings=resolved_settings,
    store=resolved_store,
    ai_service=resolved_ai_service,
    rag_service=resolved_rag_service,
    token_verifier=resolved_verifier,
    internal_verifier=internal_verifier,
    webhook_verifier=webhook_verifier,
    job_queue=job_queue,
    metrics_registry=metrics,
    audit_sink=audit,
    memory_runtime=resolved_memory_runtime,
    response_canary_router=response_canary_router,
  )


def _build_response_canary(settings: Settings) -> ResponseCanaryRouter:
  from ..ops.response_canary import ResponseCanaryRouter

  return ResponseCanaryRouter(
    settings.rag_response_promotion_pointer_path,
    candidate_id=str(settings.rag_response_candidate_id),
  )
