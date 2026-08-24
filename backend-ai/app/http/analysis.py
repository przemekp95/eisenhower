from __future__ import annotations

import logging
import time

from fastapi import APIRouter, HTTPException, Request

from ..rag.models import AccessScope, AnalyzeResult, RetrievalSummary
from .composition import AppDependencies
from .schemas import AnalyzeRequest, BatchRequest, ClassifyRequest, MAX_TASK_LENGTH, RagAnalyzeRequest


request_logger = logging.getLogger("uvicorn.error")


def create_analysis_router(deps: AppDependencies) -> APIRouter:
  router = APIRouter()
  settings = deps.settings
  ai_service = deps.ai_service
  rag_service = deps.rag_service
  metrics = deps.metrics_registry
  response_canary_router = deps.response_canary_router

  @router.post("/v2/ai/analyze", response_model=AnalyzeResult)
  def analyze_with_rag(request: RagAnalyzeRequest, http_request: Request):
    analysis_started = time.perf_counter()
    principal = http_request.state.principal
    if "*" not in principal.scopes and "ai:analyze" not in principal.scopes:
      raise HTTPException(status_code=403, detail="Missing ai:analyze scope.")
    scope = AccessScope(
      tenant_id=principal.tenant_id,
      user_id=principal.user_id,
      project_ids=principal.project_ids,
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
    current_world_abstention = (
      rag_service is not None
      and tenant_enabled
      and request.freshness_requirement == "current_world_required"
    )
    response_promotion_reason = None
    if (
      response_canary_router is not None
      and settings.rag_response_enabled
      and generation_enabled
      and tenant_enabled
      and user_enabled
    ):
      response_canary_decision = response_canary_router.evaluate(
        principal.tenant_id, principal.user_id
      )
      metrics.observe_response_canary(response_canary_decision.outcome)
      response_promotion_reason = response_canary_decision.reason
    response_enabled = (
      generation_enabled
      and settings.rag_response_enabled
      and tenant_enabled
      and user_enabled
      and response_promotion_reason is None
    )
    if (rag_service is not None and response_enabled) or current_world_abstention:
      delta_requested = (
        request.known_state is not None
        or request.previous_output_statements is not None
        or request.freshness_requirement == "current_world_required"
      )
      if delta_requested:
        result = rag_service.analyze(
          request.task,
          scope,
          language=request.language,
          known_state=request.known_state,
          previous_output_statements=request.previous_output_statements,
          freshness_requirement=request.freshness_requirement,
        )
      else:
        result = rag_service.analyze(request.task, scope, language=request.language)
    else:
      if rag_service is not None and tenant_enabled and generation_enabled:
        generation_started = time.perf_counter()
        try:
          shadow_result = rag_service.analyze(
            request.task,
            scope,
            language=request.language,
          )
          shadow_outcome = "no_answer" if shadow_result.mode == "no_answer" else "success"
          metrics.observe_generation(
            shadow_outcome,
            duration_seconds=time.perf_counter() - generation_started,
            input_tokens=(
              shadow_result.generation.input_tokens
              if shadow_result.generation is not None
              else 0
            ),
          )
          if shadow_result.generation is not None:
            metrics.observe_rag_validation("schema", "accepted")
            if shadow_result.mode == "rag":
              metrics.observe_rag_validation("citations", "accepted")
        except Exception:
          request_logger.warning("Optional generation shadow failed", exc_info=True)
          metrics.observe_generation(
            "unavailable",
            duration_seconds=time.perf_counter() - generation_started,
            input_tokens=0,
          )
      elif rag_service is not None and tenant_enabled:
        retrieval_started = time.perf_counter()
        try:
          shadow = rag_service.retrieve_summary(request.task, scope)
          metrics.observe_rag_retrieval(
            "shadow",
            hit_count=shadow.hit_count,
            duration_seconds=time.perf_counter() - retrieval_started,
          )
        except Exception:
          request_logger.warning("Optional shadow retrieval failed", exc_info=True)
          metrics.observe_rag_retrieval(
            "shadow",
            hit_count=None,
            duration_seconds=time.perf_counter() - retrieval_started,
          )
      classification = ai_service.classify_task(request.task, use_rag=False)
      if rag_service is None:
        fallback_reason = "rag_disabled"
      elif not settings.rag_response_enabled:
        fallback_reason = "rag_response_disabled"
      elif not generation_enabled:
        fallback_reason = "generation_disabled"
      elif not tenant_enabled:
        fallback_reason = "tenant_not_enabled"
      elif not user_enabled:
        fallback_reason = "user_not_enabled"
      else:
        fallback_reason = response_promotion_reason or "response_promotion_invalid"
      result = AnalyzeResult(
        mode="fallback",
        quadrant=classification["quadrant"],
        quadrant_name=classification["quadrant_name"],
        confidence=classification["confidence"],
        explanation="The local MiniLM classifier produced this fallback result.",
        retrieval=RetrievalSummary(),
        fallback_reason=fallback_reason,
      )
    analysis_duration = time.perf_counter() - analysis_started
    metrics.observe_rag_result(result.mode, result.fallback_reason)
    metrics.observe_rag_analysis(result.mode, duration_seconds=analysis_duration)
    if result.information_delta is not None:
      metrics.observe_information_delta(result.information_delta.status)
      metrics.observe_rag_validation("information_delta", "accepted")
    if result.generation is not None:
      generation_outcome = "no_answer" if result.mode == "no_answer" else "success"
      metrics.observe_generation(
        generation_outcome,
        duration_seconds=analysis_duration,
        input_tokens=result.generation.input_tokens,
      )
      metrics.observe_rag_validation("schema", "accepted")
      if result.mode == "rag":
        metrics.observe_rag_validation("citations", "accepted")
    elif result.fallback_reason == "invalid_generation_output":
      metrics.observe_generation("rejected", duration_seconds=analysis_duration, input_tokens=0)
      metrics.observe_rag_validation("schema", "rejected")
    elif result.fallback_reason == "invalid_citations":
      metrics.observe_generation("rejected", duration_seconds=analysis_duration, input_tokens=0)
      metrics.observe_rag_validation("citations", "rejected")
    elif result.fallback_reason == "invalid_information_delta":
      metrics.observe_generation("rejected", duration_seconds=analysis_duration, input_tokens=0)
      metrics.observe_rag_validation("information_delta", "rejected")
    elif result.fallback_reason == "generation_unavailable":
      metrics.observe_generation("unavailable", duration_seconds=analysis_duration, input_tokens=0)
    return result

  @router.post("/classify")
  def classify_text(request: ClassifyRequest):
    return ai_service.classify_task(request.title, use_rag=request.use_rag)

  @router.post("/analyze")
  def analyze_with_langchain(request: AnalyzeRequest):
    return ai_service.analyze_with_reasoning(request.task, language=request.language)

  @router.post("/analyze-langchain", deprecated=True, include_in_schema=False)
  def analyze_with_legacy_name(request: AnalyzeRequest):
    return ai_service.analyze_with_reasoning(request.task, language=request.language)

  @router.post("/batch-analyze")
  def batch_analyze_tasks(request: BatchRequest):
    tasks = [task.strip() for task in request.tasks if task.strip()]
    if not tasks:
      raise HTTPException(status_code=400, detail="At least one task is required.")
    if any(len(task) > MAX_TASK_LENGTH for task in tasks):
      raise HTTPException(
        status_code=422,
        detail=f"Each task must be at most {MAX_TASK_LENGTH} characters.",
      )
    return ai_service.batch_analyze(tasks)

  return router
