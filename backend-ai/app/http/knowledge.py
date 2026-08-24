from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request

from ..rag.errors import RerankerUnavailable
from ..rag.models import AccessScope, KnowledgeAnswerResponse, RetrievalSummary
from .composition import AppDependencies
from .schemas import KnowledgeAnswerApiRequest, KnowledgeSearchRequest, KnowledgeSearchResponse


def create_knowledge_router(deps: AppDependencies) -> APIRouter:
  router = APIRouter()
  settings = deps.settings
  rag_service = deps.rag_service
  metrics = deps.metrics_registry
  response_canary_router = deps.response_canary_router

  @router.post("/v2/knowledge/search", response_model=KnowledgeSearchResponse)
  def search_knowledge(request: KnowledgeSearchRequest, http_request: Request):
    principal = http_request.state.principal
    if "*" not in principal.scopes and not ({"knowledge:read", "ai:analyze"} & set(principal.scopes)):
      raise HTTPException(status_code=403, detail="Missing knowledge:read scope.")
    project_ids = list(principal.project_ids)
    if request.project_id:
      if "admin" not in principal.roles and request.project_id not in project_ids:
        raise HTTPException(status_code=403, detail="Project is outside the authenticated scope.")
      project_ids = [request.project_id]
    scope = AccessScope(
      tenant_id=principal.tenant_id,
      user_id=principal.user_id,
      project_ids=project_ids,
      roles=principal.roles,
    )
    if rag_service is None:
      return {
        "query": request.query,
        "answer": None,
        "citations": [],
        "retrieval": RetrievalSummary(),
        "no_answer_reason": "rag_disabled",
      }
    retrieval_started = time.perf_counter()
    try:
      result = rag_service.search(
        request.query,
        scope,
        limit=request.limit,
        project_id=request.project_id,
      )
    except RerankerUnavailable as error:
      metrics.observe_rag_retrieval(
        "search",
        hit_count=None,
        duration_seconds=time.perf_counter() - retrieval_started,
      )
      raise HTTPException(
        status_code=503,
        detail="Default retrieval reranker is unavailable.",
      ) from error
    except Exception:
      metrics.observe_rag_retrieval(
        "search",
        hit_count=None,
        duration_seconds=time.perf_counter() - retrieval_started,
      )
      raise
    metrics.observe_rag_retrieval(
      "search",
      hit_count=result["retrieval"].hit_count,
      duration_seconds=time.perf_counter() - retrieval_started,
    )
    return result

  @router.post("/v2/knowledge/answer", response_model=KnowledgeAnswerResponse)
  def answer_knowledge(request: KnowledgeAnswerApiRequest, http_request: Request):
    principal = http_request.state.principal
    if "*" not in principal.scopes and not ({"knowledge:read", "ai:analyze"} & set(principal.scopes)):
      raise HTTPException(status_code=403, detail="Missing knowledge:read scope.")
    project_ids = list(principal.project_ids)
    if request.project_id:
      if "admin" not in principal.roles and request.project_id not in project_ids:
        raise HTTPException(status_code=403, detail="Project is outside the authenticated scope.")
      project_ids = [request.project_id]
    scope = AccessScope(
      tenant_id=principal.tenant_id,
      user_id=principal.user_id,
      project_ids=project_ids,
      roles=principal.roles,
    )
    tenant_enabled = (
      not settings.rag_allowed_tenants
      or principal.tenant_id in settings.rag_allowed_tenants
    )
    user_enabled = (
      (settings.app_env != "production" and not settings.rag_response_allowed_users)
      or principal.user_id in settings.rag_response_allowed_users
    )
    generation_enabled = bool(
      rag_service is not None
      and getattr(rag_service, "generation_enabled", True)
    )
    if rag_service is None:
      reason = "rag_disabled"
    elif not settings.rag_response_enabled:
      reason = "rag_response_disabled"
    elif not generation_enabled:
      reason = "generation_disabled"
    elif not tenant_enabled:
      reason = "tenant_not_enabled"
    elif not user_enabled:
      reason = "user_not_enabled"
    elif response_canary_router is not None:
      response_canary_decision = response_canary_router.evaluate(
        principal.tenant_id, principal.user_id
      )
      metrics.observe_response_canary(response_canary_decision.outcome)
      reason = response_canary_decision.reason
    else:
      reason = None
    if reason is not None:
      return KnowledgeAnswerResponse(
        status="insufficient_evidence",
        answer=None,
        claims=[],
        citations=[],
        retrieval=RetrievalSummary(),
        no_answer_reason=reason,
      )

    started = time.perf_counter()
    result = rag_service.answer(
      request.query,
      scope,
      language=request.language,
      limit=request.limit,
      project_id=request.project_id,
    )
    metrics.observe_rag_retrieval(
      "answer",
      hit_count=result.retrieval.hit_count,
      duration_seconds=time.perf_counter() - started,
    )
    generation_outcome = "success" if result.status == "answered" else "no_answer"
    metrics.observe_generation(
      generation_outcome,
      duration_seconds=time.perf_counter() - started,
      input_tokens=result.generation.input_tokens if result.generation else 0,
    )
    return result

  return router
