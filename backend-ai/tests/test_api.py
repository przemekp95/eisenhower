from pathlib import Path
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from io import BytesIO
import hmac
import json

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from app.config import Settings
from app.audit import AuditAction, AuditOutcome
from app.auth import AuthPrincipal
from app.generation.models import InformationDelta, KnowledgeAnswerClaim, statement_checksum
from app.local_model import LocalMiniLMClassifier, LocalPrediction, ModelNotReadyError, SimilarExample
from app.jobs import SqliteJobQueue
from app.job_worker import JobWorker
from app.main import create_app
from app.rag.hybrid import RerankerUnavailable
from app.rag.models import (
  AnalyzeResult,
  KnowledgeAnswerResponse,
  RetrievalSummary,
)
from app.service import QuadrantAIService
from app.store import TrainingStore
from app.webhooks import (
  WEBHOOK_INGRESS_METHOD,
  WEBHOOK_INGRESS_PATH,
  WEBHOOK_SIGNATURE_VERSION,
  WebhookReplayVerifier,
)


class FakeLocalModel:
  def __init__(self, *, ready: bool = True, fail_predict: bool = False, startup_error: Exception | None = None):
    self.ready = ready
    self.fail_predict = fail_predict
    self.startup_error = startup_error
    self.ensure_ready_calls: list[list[dict]] = []
    self.train_calls: list[list[dict]] = []
    self.predict_many_calls: list[tuple[list[str], int]] = []

  def ensure_ready(self, records):
    self.ensure_ready_calls.append(records)
    if self.startup_error is not None:
      raise self.startup_error
    if not self.ready:
      raise ModelNotReadyError("Model bootstrap failed.")

  def status(self):
    return {
      "ready": self.ready,
      "name": "local-minilm-mlp",
      "encoder_name": "sentence-transformers/test-model",
      "artifact_path": "/tmp/local_minilm_head.pt",
      "index_path": "/tmp/local_minilm_index.json",
      "trained_at": "2026-03-09T00:00:00+00:00",
      "validation_skipped": True,
      "last_error": None if self.ready else "Model bootstrap failed.",
      "examples_seen": 8,
    }

  def predict(self, task: str, limit: int = 3):
    if self.fail_predict:
      raise ModelNotReadyError("Model not ready.")
    quadrant = 2 if "roadmap" in task else 0
    similar_examples = [
      SimilarExample(
        text="prepare strategic roadmap" if quadrant == 2 else "critical production incident",
        quadrant=quadrant,
        source="default",
        score=0.88,
      )
    ][:limit]
    return LocalPrediction(
      quadrant=quadrant,
      confidence=0.83,
      probabilities=[0.1, 0.12, 0.7, 0.08] if quadrant == 2 else [0.78, 0.1, 0.07, 0.05],
      similar_examples=similar_examples,
    )

  def predict_many(self, tasks: list[str], limit: int = 3):
    self.predict_many_calls.append((list(tasks), limit))
    return [self.predict(task, limit=limit) for task in tasks]

  def explain(self, task: str, language: str = "en", prediction: LocalPrediction | None = None):
    del prediction
    quadrant = 2 if "roadmap" in task else 0
    return {
      "quadrant": quadrant,
      "quadrant_name": "Zaplanuj" if language == "pl" and quadrant == 2 else "Schedule",
      "confidence": 0.83,
      "reasoning": "Kwadrant „Zaplanuj” wynika z lokalnego modelu." if language == "pl" else "Local model explanation.",
      "method": "local-analysis",
      "similar_examples": [],
    }

  def train(self, records):
    self.train_calls.append(records)
    self.ready = True
    return {
      "artifact_path": "/tmp/local_minilm_head.pt",
      "trained_at": "2026-03-09T00:00:00+00:00",
      "validation_skipped": True,
      "examples_seen": len(records),
    }


def build_client(
  tmp_path: Path,
  *,
  local_model: FakeLocalModel | None = None,
  tesseract_available: bool | None = None,
  audit_sink=None,
) -> TestClient:
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
  )
  store = TrainingStore(tmp_path / "training.json")
  service = QuadrantAIService(
    settings=settings,
    store=store,
    local_model=local_model or FakeLocalModel(),
  )
  if tesseract_available is not None:
    service._tesseract_available = lambda: tesseract_available  # type: ignore[method-assign]
  return TestClient(
    create_app(settings=settings, store=store, ai_service=service, audit_sink=audit_sink),
    headers={"Authorization": "Bearer test-admin-token"},
  )


def build_real_client(real_model_bundle, *, tesseract_available: bool | None = None) -> TestClient:
  settings = real_model_bundle["settings"]
  store = TrainingStore(settings.training_data_path)
  local_model = LocalMiniLMClassifier(settings=settings, encoder=real_model_bundle["encoder"])
  service = QuadrantAIService(
    settings=settings,
    store=store,
    local_model=local_model,
  )
  if tesseract_available is not None:
    service._tesseract_available = lambda: tesseract_available  # type: ignore[method-assign]
  return TestClient(
    create_app(settings=settings, store=store, ai_service=service),
    headers={"Authorization": "Bearer test-admin-token"},
  )


def test_invalid_bearer_is_an_authentication_failure_with_a_challenge(tmp_path: Path):
  client = build_client(tmp_path)

  response = client.get("/training-stats", headers={"Authorization": "Bearer wrong-code"})

  assert response.status_code == 401
  assert response.headers["www-authenticate"] == "Bearer"
  assert response.json() == {"error": "Access denied"}


class FakeRagService:
  def __init__(self):
    self.calls = []
    self.shadow_calls = []
    self.search_calls = []
    self.answer_calls = []
    self.generation_enabled = True

  def analyze(self, task, scope, *, language="en", **delta_inputs):
    self.calls.append((task, scope, language, delta_inputs))
    if delta_inputs.get("freshness_requirement") == "current_world_required":
      return AnalyzeResult(
        mode="no_answer",
        explanation="The frozen corpus cannot verify current-world freshness.",
        citations=[],
        retrieval=RetrievalSummary(hit_count=1, top_score=0.9, embedding_version="minilm-v1"),
        fallback_reason="current_world_freshness_unverified",
        information_delta=InformationDelta(
          status="freshness_unverified",
          claims=[],
          summary_code="current_world_freshness_unverified",
        ),
      )
    return AnalyzeResult(
      mode="rag",
      quadrant=2,
      quadrant_name="Schedule",
      confidence=0.84,
      explanation="Important and not urgent.",
      citations=[],
      retrieval=RetrievalSummary(hit_count=1, top_score=0.9, embedding_version="minilm-v1"),
    )

  def retrieve_summary(self, task, scope):
    self.shadow_calls.append((task, scope))
    return RetrievalSummary(hit_count=2, top_score=0.9, embedding_version="minilm-v1")

  def search(self, query, scope, *, limit=5, project_id=None):
    self.search_calls.append((query, scope, limit, project_id))
    return {
      "query": query,
      "answer": None,
      "citations": [],
      "retrieval": RetrievalSummary(hit_count=1, top_score=0.8, embedding_version="minilm-v1"),
    }

  def answer(self, query, scope, *, language="en", limit=5, project_id=None):
    self.answer_calls.append((query, scope, language, limit, project_id))
    return KnowledgeAnswerResponse(
      status="answered",
      answer="MongoDB is canonical.",
      claims=[KnowledgeAnswerClaim(
        statement="MongoDB is canonical.", citation_ids=["chunk-1"]
      )],
      citations=[],
      retrieval=RetrievalSummary(
        hit_count=1, top_score=0.9, embedding_version="bge-m3-v1"
      ),
    )


@pytest.mark.parametrize(
  ("vendor", "location", "endpoint", "allowed_hosts"),
  [
    ("nvidia-cuda", "local", "http://inference:8000/v1", ()),
    ("amd-rocm", "local", "http://inference:8000/v1", ()),
    ("nvidia-cuda", "remote", "https://nvidia-gpu.mesh.example/v1", ("nvidia-gpu.mesh.example",)),
    ("amd-rocm", "remote", "https://amd-gpu.mesh.example/v1", ("amd-gpu.mesh.example",)),
  ],
)
def test_fastapi_contract_is_invariant_across_gpu_vendor_and_endpoint_location(
  tmp_path: Path,
  vendor: str,
  location: str,
  endpoint: str,
  allowed_hosts: tuple[str, ...],
):
  settings = Settings(
    training_data_path=tmp_path / f"{vendor}-{location}.json",
    model_cache_dir=tmp_path / f"{vendor}-{location}-runtime",
    rag_retrieval_enabled=True,
    rag_generation_enabled=True,
    rag_response_enabled=True,
    inference_base_url=endpoint,
    inference_allowed_hosts=allowed_hosts,
    inference_api_key="service-token",
    inference_model="approved-model",
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service, rag_service=FakeRagService()),
    headers={"Authorization": "Bearer test-api-token"},
  )

  response = client.post("/v2/ai/analyze", json={"task": "Prepare roadmap"})

  assert response.status_code == 200
  assert response.json() == {
    "mode": "rag",
    "quadrant": 2,
    "quadrant_name": "Schedule",
    "confidence": 0.84,
    "explanation": "Important and not urgent.",
    "citations": [],
    "retrieval": {"hit_count": 1, "top_score": 0.9, "embedding_version": "minilm-v1"},
    "generation": None,
    "information_delta": None,
    "fallback_reason": None,
  }


def test_v2_rag_contract_uses_authenticated_scope_not_client_tenant(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_response_enabled=True,
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  rag = FakeRagService()
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service, rag_service=rag),
    headers={"Authorization": "Bearer test-api-token"},
  )

  response = client.post("/v2/ai/analyze", json={"task": "Prepare roadmap"})

  assert response.status_code == 200
  assert response.json()["mode"] == "rag"
  assert response.json()["retrieval"]["embedding_version"] == "minilm-v1"
  assert rag.calls[0][1].tenant_id == "local"
  assert rag.calls[0][1].user_id == "local-user"


def test_v2_rag_contract_forwards_bounded_known_state_and_rejects_duplicate_ids(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_response_enabled=True,
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  rag = FakeRagService()
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service, rag_service=rag),
    headers={"Authorization": "Bearer test-api-token"},
  )
  text = "Termin upływa 15 sierpnia."
  statement = {
    "statement_id": "known-1",
    "statement": text,
    "language": "pl",
    "checksum": statement_checksum(text),
  }

  response = client.post(
    "/v2/ai/analyze",
    json={"task": "Jaki jest termin?", "language": "pl", "known_state": [statement]},
  )
  duplicate = client.post(
    "/v2/ai/analyze",
    json={
      "task": "Jaki jest termin?",
      "known_state": [statement],
      "previous_output_statements": [statement],
    },
  )

  assert response.status_code == 200
  assert rag.calls[0][3]["known_state"][0].statement_id == "known-1"
  assert duplicate.status_code == 422


def test_v2_current_world_request_abstains_even_when_generation_is_disabled(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_retrieval_enabled=True,
    rag_generation_enabled=False,
    rag_response_enabled=False,
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  rag = FakeRagService()
  rag.generation_enabled = False
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service, rag_service=rag),
    headers={"Authorization": "Bearer test-api-token"},
  )

  response = client.post(
    "/v2/ai/analyze",
    json={
      "task": "Jaki jest termin dzisiaj?",
      "language": "pl",
      "freshness_requirement": "current_world_required",
    },
  )

  assert response.status_code == 200
  assert response.json()["mode"] == "no_answer"
  assert response.json()["information_delta"]["status"] == "freshness_unverified"
  assert response.json()["fallback_reason"] == "current_world_freshness_unverified"
  assert rag.calls[0][3]["freshness_requirement"] == "current_world_required"


def test_v2_rag_response_flag_and_tenant_cohort_fall_back_safely(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_response_enabled=True,
    rag_allowed_tenants=("other-tenant",),
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  rag = FakeRagService()
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service, rag_service=rag),
    headers={"Authorization": "Bearer test-api-token"},
  )

  response = client.post("/v2/ai/analyze", json={"task": "Prepare roadmap"})

  assert response.status_code == 200
  assert response.json()["mode"] == "fallback"
  assert response.json()["fallback_reason"] == "tenant_not_enabled"
  assert not rag.calls
  assert not rag.shadow_calls


def test_v2_shadow_retrieval_runs_without_exposing_hits_or_calling_generation(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_retrieval_enabled=True,
    rag_generation_enabled=False,
    rag_response_enabled=False,
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  rag = FakeRagService()
  rag.generation_enabled = False
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service, rag_service=rag),
    headers={"Authorization": "Bearer test-api-token"},
  )

  response = client.post("/v2/ai/analyze", json={"task": "Prepare roadmap"})
  metrics = client.get("/metrics")

  assert response.status_code == 200
  assert response.json()["mode"] == "fallback"
  assert response.json()["fallback_reason"] == "rag_response_disabled"
  assert response.json()["retrieval"] == {
    "hit_count": 0,
    "top_score": None,
    "embedding_version": None,
  }
  assert not rag.calls
  assert len(rag.shadow_calls) == 1
  assert 'eisenhower_rag_retrieval_total{stage="shadow",outcome="hit"} 1' in metrics.text
  assert 'eisenhower_rag_retrieval_duration_seconds_count{stage="shadow",outcome="hit"} 1' in metrics.text
  assert 'eisenhower_rag_analysis_duration_seconds_count{mode="fallback"} 1' in metrics.text


def test_v2_generation_shadow_validates_and_discards_model_output(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_retrieval_enabled=True,
    rag_generation_enabled=True,
    rag_response_enabled=False,
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  rag = FakeRagService()
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service, rag_service=rag),
    headers={"Authorization": "Bearer test-api-token"},
  )

  response = client.post("/v2/ai/analyze", json={"task": "Prepare roadmap"})
  metrics = client.get("/metrics")

  assert response.status_code == 200
  assert response.json()["mode"] == "fallback"
  assert response.json()["fallback_reason"] == "rag_response_disabled"
  assert response.json()["citations"] == []
  assert response.json()["generation"] is None
  assert len(rag.calls) == 1
  assert not rag.shadow_calls
  assert 'eisenhower_rag_generation_total{outcome="success"} 1' in metrics.text


def test_v2_response_canary_requires_the_authenticated_user(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_retrieval_enabled=True,
    rag_generation_enabled=True,
    rag_response_enabled=True,
    rag_allowed_tenants=("local",),
    rag_response_allowed_users=("different-user",),
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  rag = FakeRagService()
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service, rag_service=rag),
    headers={"Authorization": "Bearer test-api-token"},
  )

  response = client.post("/v2/ai/analyze", json={"task": "Prepare roadmap"})

  assert response.status_code == 200
  assert response.json()["mode"] == "fallback"
  assert response.json()["fallback_reason"] == "user_not_enabled"
  assert len(rag.calls) == 1


def test_v2_knowledge_search_forwards_the_authorized_project_filter(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_retrieval_enabled=True,
    rag_generation_enabled=False,
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  rag = FakeRagService()
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service, rag_service=rag),
    headers={"Authorization": "Bearer test-admin-token"},
  )

  response = client.post(
    "/v2/knowledge/search",
    json={"query": "roadmap", "project_id": "local-project", "limit": 3},
  )
  metrics = client.get("/metrics")

  assert response.status_code == 200
  assert rag.search_calls[0][2:] == (3, "local-project")
  assert rag.search_calls[0][1].project_ids == ["local-project"]
  assert 'eisenhower_rag_retrieval_duration_seconds_count{stage="search",outcome="hit"} 1' in metrics.text
  assert 'eisenhower_rag_retrieved_chunks_sum{stage="search"} 1' in metrics.text


def test_v2_knowledge_answer_uses_authenticated_scope_and_response_canary(tmp_path: Path):
  pointer = tmp_path / "promotion.json"
  pointer.write_text(json.dumps({
    "schema_version": "ai-promotion-pointer-v1",
    "revision": 3,
    "previous_revision": 2,
    "phases": {
      "retrieval": {"mode": "canary", "candidate_id": "rag-v1", "canary_percent": 5},
      "generation": {"mode": "canary", "candidate_id": "llm-v1", "canary_percent": 5},
      "response": {
        "mode": "canary", "candidate_id": "answer-v12", "canary_percent": 5,
        "quality_report_checksum": "a" * 64, "approval_checksum": "b" * 64,
        "approval_valid_until": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
      },
      "mag": {"mode": "disabled", "candidate_id": None, "canary_percent": 0},
    },
  }), encoding="utf-8")
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_retrieval_enabled=True,
    rag_generation_enabled=True,
    rag_response_enabled=True,
    rag_allowed_tenants=("local",),
    rag_response_allowed_users=("local-user",),
    rag_response_promotion_pointer_path=pointer,
    rag_response_candidate_id="answer-v12",
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  rag = FakeRagService()
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service, rag_service=rag),
    headers={"Authorization": "Bearer test-api-token"},
  )

  response = client.post(
    "/v2/knowledge/answer",
    json={"query": "Co jest kanoniczne?", "language": "pl", "limit": 3},
  )

  assert response.status_code == 200
  assert response.json()["status"] == "answered"
  assert response.json()["answer"] == "MongoDB is canonical."
  assert rag.answer_calls[0][1].tenant_id == "local"
  assert rag.answer_calls[0][1].user_id == "local-user"
  assert rag.answer_calls[0][2:] == ("pl", 3, None)


def test_v2_analysis_response_canary_reloads_pointer_and_expires_without_restart(tmp_path: Path):
  pointer = tmp_path / "promotion.json"

  def write_pointer(valid_until: datetime) -> None:
    pointer.write_text(json.dumps({
      "schema_version": "ai-promotion-pointer-v1", "revision": 3, "previous_revision": 2,
      "phases": {
        "retrieval": {"mode": "canary", "candidate_id": "rag-v1", "canary_percent": 5},
        "generation": {"mode": "canary", "candidate_id": "llm-v1", "canary_percent": 5},
        "response": {
          "mode": "canary", "candidate_id": "answer-v12", "canary_percent": 5,
          "quality_report_checksum": "a" * 64, "approval_checksum": "b" * 64,
          "approval_valid_until": valid_until.isoformat(),
        },
        "mag": {"mode": "disabled", "candidate_id": None, "canary_percent": 0},
      },
    }), encoding="utf-8")

  write_pointer(datetime.now(timezone.utc) + timedelta(minutes=5))
  settings = Settings(
    training_data_path=tmp_path / "training.json", model_cache_dir=tmp_path / "runtime",
    rag_retrieval_enabled=True, rag_generation_enabled=True, rag_response_enabled=True,
    rag_allowed_tenants=("local",), rag_response_allowed_users=("local-user",),
    rag_response_promotion_pointer_path=pointer, rag_response_candidate_id="answer-v12",
  )
  store = TrainingStore(settings.training_data_path)
  rag = FakeRagService()
  client = TestClient(create_app(
    settings=settings,
    store=store,
    ai_service=QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel()),
    rag_service=rag,
  ), headers={"Authorization": "Bearer test-api-token"})

  selected = client.post("/v2/ai/analyze", json={"task": "Prepare roadmap"})
  write_pointer(datetime.now(timezone.utc) - timedelta(seconds=1))
  expired = client.post("/v2/ai/analyze", json={"task": "Prepare roadmap"})
  metrics = client.get("/metrics").text

  assert selected.json()["mode"] == "rag"
  assert expired.json()["mode"] == "fallback"
  assert expired.json()["fallback_reason"] == "response_approval_expired"
  assert 'eisenhower_response_canary_decisions_total{outcome="selected"} 1' in metrics
  assert 'eisenhower_response_canary_decisions_total{outcome="approval_expired"} 1' in metrics


def test_v2_knowledge_answer_abstains_without_retrieval_when_canary_is_disabled(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_retrieval_enabled=True,
    rag_generation_enabled=True,
    rag_response_enabled=False,
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  rag = FakeRagService()
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service, rag_service=rag),
    headers={"Authorization": "Bearer test-api-token"},
  )

  response = client.post("/v2/knowledge/answer", json={"query": "Question"})

  assert response.status_code == 200
  assert response.json()["status"] == "insufficient_evidence"
  assert response.json()["answer"] is None
  assert response.json()["citations"] == []
  assert response.json()["no_answer_reason"] == "rag_response_disabled"
  assert rag.answer_calls == []


def test_v2_knowledge_search_reports_default_reranker_unavailable_without_dense_results(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_retrieval_enabled=True,
    rag_generation_enabled=False,
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  rag = FakeRagService()

  def unavailable(*_args, **_kwargs):
    raise RerankerUnavailable("reranker provider failed")

  rag.search = unavailable
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service, rag_service=rag),
    headers={"Authorization": "Bearer test-admin-token"},
  )

  response = client.post("/v2/knowledge/search", json={"query": "roadmap"})

  assert response.status_code == 503
  assert response.json()["error"] == "Default retrieval reranker is unavailable."


def test_non_root_endpoint_requires_bearer_token(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  client = TestClient(create_app(settings=settings, store=store, ai_service=service))

  response = client.get("/capabilities")

  assert response.status_code == 401
  assert response.headers["www-authenticate"] == "Bearer"


class RecordingAuditSink:
  def __init__(self, *, fail: bool = False):
    self.events = []
    self.fail = fail

  def record(self, event):
    if self.fail:
      raise RuntimeError("audit unavailable")
    self.events.append(event)
    return event


def test_auth_rejection_is_durably_audited_without_request_content(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  audit = RecordingAuditSink()
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service, audit_sink=audit)
  )

  response = client.post(
    "/v2/knowledge/search",
    json={"query": "private query body"},
    headers={"X-Request-ID": "request-auth-rejection"},
  )

  assert response.status_code == 401
  assert response.headers["X-Request-ID"] == "request-auth-rejection"
  assert len(audit.events) == 1
  event = audit.events[0]
  assert event.action is AuditAction.AUTH_REJECTION
  assert event.outcome is AuditOutcome.REJECTED
  assert event.request_id == "request-auth-rejection"
  assert "private query body" not in repr(event)


def test_admin_mutation_records_attempt_and_success_and_fails_closed_without_audit(tmp_path: Path):
  audit = RecordingAuditSink()
  client = build_client(tmp_path, audit_sink=audit)

  response = client.post(
    "/add-example",
    data={"text": "private example", "quadrant": 2},
    headers={"X-Request-ID": "request-admin-mutation"},
  )

  assert response.status_code == 200
  assert [(event.action, event.outcome) for event in audit.events] == [
    (AuditAction.ADMIN_OPERATION, AuditOutcome.ATTEMPT),
    (AuditAction.ADMIN_OPERATION, AuditOutcome.SUCCESS),
  ]
  assert all("private example" not in repr(event) for event in audit.events)

  blocked = build_client(tmp_path / "blocked", audit_sink=RecordingAuditSink(fail=True)).post(
    "/add-example",
    data={"text": "must not persist", "quadrant": 2},
  )
  assert blocked.status_code == 503


def test_metrics_exposes_aggregate_prometheus_signals_without_auth(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  client = TestClient(create_app(settings=settings, store=store, ai_service=service))

  response = client.get("/metrics")

  assert response.status_code == 200
  assert "eisenhower_http_requests_total" in response.text
  assert "tenant_id" not in response.text


def test_signed_internal_ingestion_is_replay_safe_and_idempotently_queued(tmp_path: Path):
  secret = "webhook-secret"
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    internal_api_token="internal-token",
    internal_allowed_tenants=("tenant-a",),
    webhook_secret=secret,
    jobs_database_path=tmp_path / "jobs.sqlite3",
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service),
    headers={"Authorization": "Bearer internal-token"},
  )
  event = {
    "schema_version": "2",
    "event_id": "00000000-0000-4000-8000-000000000001",
    "operation": "upsert",
    "tenant_id": "tenant-a",
    "project_id": "project-1",
    "source_version": "v1",
    "source_sequence": 1,
    "content_checksum": f"sha256:{'a' * 64}",
    "embedding_version": "minilm-v1",
    "chunking_version": "chars-v1",
    "documents": [
      {
        "document_id": "doc-1",
        "source_type": "task",
        "title": "One",
        "content": "Task body",
        "acl": {"owner_id": "owner-1"},
      }
    ],
  }
  timestamp = str(int(datetime.now(timezone.utc).timestamp()))
  raw_body = json.dumps(event, indent=2).encode("utf-8")
  signature_message = WebhookReplayVerifier.signature_message(timestamp, raw_body)
  signature = hmac.new(secret.encode(), signature_message, sha256).hexdigest()
  webhook_headers = {
    "Content-Type": "application/json; charset=utf-8",
    "X-Eisenhower-Timestamp": timestamp,
    "X-Eisenhower-Signature": signature,
    "X-Eisenhower-Signature-Version": WEBHOOK_SIGNATURE_VERSION,
    "X-Eisenhower-Signed-Method": WEBHOOK_INGRESS_METHOD,
    "X-Eisenhower-Signed-Path": WEBHOOK_INGRESS_PATH,
  }

  verified = client.post(
    "/internal/webhooks/n8n/verify",
    content=raw_body,
    headers=webhook_headers,
  )
  durable_job = SqliteJobQueue(settings.jobs_database_path).get(verified.json()["job_id"])
  replay = client.post(
    "/internal/webhooks/n8n/verify",
    content=raw_body,
    headers=webhook_headers,
  )
  changed_event = {**event, "source_version": "v2"}
  changed_raw = json.dumps(changed_event, separators=(",", ":")).encode("utf-8")
  changed_signature = hmac.new(
    secret.encode(),
    WebhookReplayVerifier.signature_message(timestamp, changed_raw),
    sha256,
  ).hexdigest()
  changed_replay = client.post(
    "/internal/webhooks/n8n/verify",
    content=changed_raw,
    headers={**webhook_headers, "X-Eisenhower-Signature": changed_signature},
  )
  dispatched = client.post(
    "/internal/rag/ingestion/upsert",
    json={key: value for key, value in event.items() if key not in {"operation", "schema_version"}},
    headers={
      "Idempotency-Key": event["event_id"],
      "X-Eisenhower-Signature": verified.json()["internal_signature"],
    },
  )

  assert verified.json()["accepted"] is True
  assert verified.json()["status"] == "queued"
  assert durable_job is not None
  assert durable_job.status == "queued"
  assert durable_job.payload == {
    key: value for key, value in event.items() if key not in {"operation", "schema_version"}
  }
  assert replay.json()["accepted"] is False
  assert replay.json()["job_id"] == durable_job.job_id
  assert changed_replay.status_code == 409
  assert changed_replay.json() == {
    "error": "Idempotency key is already bound to a different job request."
  }
  assert dispatched.status_code == 202
  assert dispatched.json()["job_id"] == durable_job.job_id
  assert dispatched.json()["status"] == "queued"


def test_webhook_verification_fails_closed_before_reserving_event_id(tmp_path: Path):
  secret = "webhook-secret"
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    internal_api_token="internal-token",
    internal_allowed_tenants=("tenant-a",),
    webhook_secret=secret,
    jobs_database_path=tmp_path / "jobs.sqlite3",
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service),
    headers={"Authorization": "Bearer internal-token"},
  )
  event_id = "00000000-0000-4000-8000-000000000002"
  valid_event = {
    "schema_version": "2",
    "event_id": event_id,
    "operation": "reindex_project",
    "tenant_id": "tenant-a",
    "project_id": "project-1",
    "source_version": "v1",
    "source_sequence": 1,
    "content_checksum": f"sha256:{'a' * 64}",
    "embedding_version": "minilm-v1",
    "chunking_version": "chars-v1",
  }
  timestamp = str(int(datetime.now(timezone.utc).timestamp()))

  def headers_for(raw_body: bytes) -> dict[str, str]:
    signature = hmac.new(
      secret.encode(),
      WebhookReplayVerifier.signature_message(timestamp, raw_body),
      sha256,
    ).hexdigest()
    return {
      "Content-Type": "application/json",
      "X-Eisenhower-Timestamp": timestamp,
      "X-Eisenhower-Signature": signature,
      "X-Eisenhower-Signature-Version": WEBHOOK_SIGNATURE_VERSION,
      "X-Eisenhower-Signed-Method": WEBHOOK_INGRESS_METHOD,
      "X-Eisenhower-Signed-Path": WEBHOOK_INGRESS_PATH,
    }

  invalid_raw = json.dumps({**valid_event, "unexpected": True}).encode("utf-8")
  invalid = client.post(
    "/internal/webhooks/n8n/verify",
    content=invalid_raw,
    headers=headers_for(invalid_raw),
  )
  valid_raw = json.dumps(valid_event, separators=(",", ":")).encode("utf-8")
  accepted = client.post(
    "/internal/webhooks/n8n/verify",
    content=valid_raw,
    headers=headers_for(valid_raw),
  )
  duplicate_raw = valid_raw.replace(b'"project-1"', b'"project-1","project_id":"project-1"')
  duplicate = client.post(
    "/internal/webhooks/n8n/verify",
    content=duplicate_raw,
    headers=headers_for(duplicate_raw),
  )
  wrong_media_type = client.post(
    "/internal/webhooks/n8n/verify",
    content=valid_raw,
    headers={**headers_for(valid_raw), "Content-Type": "text/plain"},
  )
  unsigned_malformed = client.post(
    "/internal/webhooks/n8n/verify",
    content=b"{",
    headers={"Content-Type": "application/json"},
  )

  assert invalid.status_code == 422
  assert invalid.json() == {"error": "Invalid ingestion envelope."}
  assert accepted.status_code == 200
  assert accepted.json()["accepted"] is True
  assert duplicate.status_code == 422
  assert wrong_media_type.status_code == 415
  assert unsigned_malformed.status_code == 200
  assert unsigned_malformed.json() == {"accepted": False}


def test_signed_webhook_is_durably_queued_before_replay_reservation(tmp_path: Path, monkeypatch):
  secret = "webhook-secret"
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    internal_api_token="internal-token",
    internal_allowed_tenants=("tenant-a",),
    webhook_secret=secret,
    jobs_database_path=tmp_path / "jobs.sqlite3",
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service),
    headers={"Authorization": "Bearer internal-token"},
    raise_server_exceptions=False,
  )
  event = {
    "schema_version": "2",
    "event_id": "00000000-0000-4000-8000-000000000099",
    "operation": "reindex_project",
    "tenant_id": "tenant-a",
    "project_id": "project-1",
    "source_version": "v1",
    "source_sequence": 1,
    "content_checksum": f"sha256:{'a' * 64}",
    "embedding_version": "minilm-v1",
    "chunking_version": "chars-v1",
  }
  timestamp = str(int(datetime.now(timezone.utc).timestamp()))
  raw_body = json.dumps(event, separators=(",", ":")).encode("utf-8")
  signature = hmac.new(
    secret.encode(),
    WebhookReplayVerifier.signature_message(timestamp, raw_body),
    sha256,
  ).hexdigest()

  def fail_reservation(_self, _event_id):
    raise RuntimeError("simulated crash after durable enqueue")

  monkeypatch.setattr(WebhookReplayVerifier, "reserve_event", fail_reservation)
  response = client.post(
    "/internal/webhooks/n8n/verify",
    content=raw_body,
    headers={
      "Content-Type": "application/json",
      "X-Eisenhower-Timestamp": timestamp,
      "X-Eisenhower-Signature": signature,
      "X-Eisenhower-Signature-Version": WEBHOOK_SIGNATURE_VERSION,
      "X-Eisenhower-Signed-Method": WEBHOOK_INGRESS_METHOD,
      "X-Eisenhower-Signed-Path": WEBHOOK_INGRESS_PATH,
    },
  )

  assert response.status_code == 500
  assert SqliteJobQueue(settings.jobs_database_path).counts_by_status() == {"queued": 1}


def test_webhook_verification_rejects_oversized_declared_body(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    internal_api_token="internal-token",
    webhook_secret="webhook-secret",
    jobs_database_path=tmp_path / "jobs.sqlite3",
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service),
    headers={"Authorization": "Bearer internal-token"},
  )

  response = client.post(
    "/internal/webhooks/n8n/verify",
    content=b"{}",
    headers={"Content-Type": "application/json", "Content-Length": str(8 * 1024 * 1024 + 1)},
  )

  assert response.status_code == 413
  assert response.json() == {"error": "Webhook body exceeds the 8 MiB limit."}


def test_internal_job_idempotency_key_reuse_with_a_different_request_returns_conflict(
  tmp_path: Path,
):
  secret = "webhook-secret"
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    internal_api_token="internal-token",
    internal_allowed_tenants=("tenant-a",),
    webhook_secret=secret,
    jobs_database_path=tmp_path / "jobs.sqlite3",
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service),
    headers={"Authorization": "Bearer internal-token"},
  )
  base_event = {
    "event_id": "event-conflict",
    "tenant_id": "tenant-a",
    "project_id": "project-1",
    "source_version": "v1",
    "source_sequence": 1,
    "content_checksum": f"sha256:{'a' * 64}",
    "embedding_version": "minilm-v1",
    "chunking_version": "chars-v1",
  }
  upsert_signature = hmac.new(
    secret.encode(),
    b"event-conflict|tenant-a|upsert",
    sha256,
  ).hexdigest()
  upsert_headers = {
    "Idempotency-Key": "event-conflict",
    "X-Eisenhower-Signature": upsert_signature,
  }
  initial_payload = {**base_event, "documents": [{"document_id": "doc-1"}]}

  created = client.post(
    "/internal/rag/ingestion/upsert",
    json=initial_payload,
    headers=upsert_headers,
  )
  replay = client.post(
    "/internal/rag/ingestion/upsert",
    json=initial_payload,
    headers=upsert_headers,
  )
  changed_payload = client.post(
    "/internal/rag/ingestion/upsert",
    json={**initial_payload, "content_checksum": f"sha256:{'b' * 64}"},
    headers=upsert_headers,
  )
  tombstone_signature = hmac.new(
    secret.encode(),
    b"event-conflict|tenant-a|tombstone",
    sha256,
  ).hexdigest()
  changed_type = client.post(
    "/internal/rag/ingestion/tombstone",
    json={**base_event, "document_ids": ["doc-1"]},
    headers={
      "Idempotency-Key": "event-conflict",
      "X-Eisenhower-Signature": tombstone_signature,
    },
  )

  assert created.status_code == 202
  assert replay.status_code == 202
  assert replay.json() == created.json()
  assert changed_payload.status_code == 409
  assert changed_payload.json() == {
    "error": "Idempotency key is already bound to a different job request."
  }
  assert changed_type.status_code == 409
  assert changed_type.json() == changed_payload.json()


def test_internal_document_extraction_is_strictly_validated_and_durably_enqueued(
  tmp_path: Path,
):
  secret = "webhook-secret"
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    internal_api_token="internal-token",
    internal_allowed_tenants=("tenant-a",),
    webhook_secret=secret,
    jobs_database_path=tmp_path / "jobs.sqlite3",
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service),
    headers={"Authorization": "Bearer internal-token"},
  )
  payload = {
    "event_id": "extract-event-1",
    "tenant_id": "tenant-a",
    "source": "corpus://approved/handbook.pdf",
    "scope": {
      "tenant_id": "tenant-a",
      "user_id": "user-1",
      "project_ids": ["project-1"],
      "roles": ["knowledge-reader"],
    },
    "source_sequence": 7,
    "ocr": None,
  }
  signature = hmac.new(
    secret.encode(),
    b"extract-event-1|tenant-a|extract_document",
    sha256,
  ).hexdigest()

  response = client.post(
    "/internal/rag/ingestion/extract",
    json=payload,
    headers={
      "Idempotency-Key": payload["event_id"],
      "X-Eisenhower-Signature": signature,
    },
  )

  assert response.status_code == 202
  queued = SqliteJobQueue(settings.jobs_database_path).get(response.json()["job_id"])
  assert queued is not None
  assert queued.job_type == "rag.extract_document"
  assert queued.payload == payload


def test_internal_document_extraction_rejects_cross_tenant_scope_before_enqueue(
  tmp_path: Path,
):
  secret = "webhook-secret"
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    internal_api_token="internal-token",
    internal_allowed_tenants=("tenant-a",),
    webhook_secret=secret,
    jobs_database_path=tmp_path / "jobs.sqlite3",
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service),
    headers={"Authorization": "Bearer internal-token"},
  )
  signature = hmac.new(
    secret.encode(),
    b"extract-event-cross-tenant|tenant-a|extract_document",
    sha256,
  ).hexdigest()

  response = client.post(
    "/internal/rag/ingestion/extract",
    json={
      "event_id": "extract-event-cross-tenant",
      "tenant_id": "tenant-a",
      "source": "corpus://approved/handbook.pdf",
      "scope": {
        "tenant_id": "tenant-b",
        "user_id": "user-1",
        "project_ids": [],
        "roles": [],
      },
      "source_sequence": 7,
      "ocr": None,
    },
    headers={
      "Idempotency-Key": "extract-event-cross-tenant",
      "X-Eisenhower-Signature": signature,
    },
  )

  assert response.status_code == 422
  assert SqliteJobQueue(settings.jobs_database_path).counts_by_status() == {}


def test_internal_document_extraction_reaches_worker_over_the_same_sqlite_queue(
  tmp_path: Path,
):
  secret = "webhook-secret"
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    internal_api_token="internal-token",
    internal_allowed_tenants=("tenant-a",),
    webhook_secret=secret,
    jobs_database_path=tmp_path / "shared" / "jobs.sqlite3",
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service),
    headers={"Authorization": "Bearer internal-token"},
  )
  payload = {
    "event_id": "extract-runtime-1",
    "tenant_id": "tenant-a",
    "source": "corpus/approved-documents/extraction-golden-en.html",
    "scope": {"tenant_id": "tenant-a", "user_id": "user-1"},
    "source_sequence": 1,
    "ocr": None,
  }
  signature = hmac.new(
    secret.encode(),
    b"extract-runtime-1|tenant-a|extract_document",
    sha256,
  ).hexdigest()

  accepted = client.post(
    "/internal/rag/ingestion/extract",
    json=payload,
    headers={
      "Idempotency-Key": payload["event_id"],
      "X-Eisenhower-Signature": signature,
    },
  )
  observed = []
  queue = SqliteJobQueue(settings.jobs_database_path)
  worker = JobWorker(queue, {"rag.extract_document": observed.append})

  processed = worker.run_once(worker_id="runtime-verifier")

  assert accepted.status_code == 202
  assert processed is True
  assert observed == [{
    **payload,
    "scope": {**payload["scope"], "project_ids": [], "roles": []},
  }]
  assert queue.get(accepted.json()["job_id"]).status == "completed"


def test_root_and_capabilities(real_model_bundle):
  client = build_real_client(real_model_bundle, tesseract_available=True)

  root = client.get("/")
  capabilities = client.get("/capabilities")
  readiness = client.get("/health/ready")

  assert root.status_code == 200
  assert readiness.status_code == 200
  assert capabilities.status_code == 200
  assert set(capabilities.json()) == {
    "classification",
    "reasoned_local_analysis",
    "knowledge_retrieval",
    "retrieval_augmented_generation",
    "local_similar_examples",
    "ocr",
    "batch_analysis",
    "memory_write",
    "memory_retrieval",
    "memory_response",
  }
  assert capabilities.json()["classification"] is True
  assert capabilities.json()["retrieval_augmented_generation"] is False
  assert capabilities.json()["local_similar_examples"] is True
  assert capabilities.json()["memory_write"] is False
  assert capabilities.json()["memory_retrieval"] is False
  assert capabilities.json()["memory_response"] is False

  operator_capabilities = client.get("/operator/capabilities")
  assert operator_capabilities.status_code == 200
  assert operator_capabilities.json()["providers"]["local_model"] is True
  assert operator_capabilities.json()["providers"]["ocr"] is True
  assert operator_capabilities.json()["provider_controls"]["local_model"]["enabled"] is True
  assert operator_capabilities.json()["legacy"]["langchain_analysis"] is False
  assert "device" in operator_capabilities.json()
  business_user_operator_view = client.get(
    "/operator/capabilities",
    headers={"Authorization": "Bearer test-api-token"},
  )
  assert business_user_operator_view.status_code == 403


def test_business_admin_cannot_access_operator_capabilities_or_controls(tmp_path: Path):
  class BusinessAdminVerifier:
    def verify(self, _token: str) -> AuthPrincipal:
      return AuthPrincipal(
        tenant_id="local",
        user_id="business-admin",
        roles=["admin"],
        scopes=["ai:analyze"],
      )

  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  client = TestClient(
    create_app(
      settings=settings,
      store=store,
      ai_service=service,
      token_verifier=BusinessAdminVerifier(),
    ),
    headers={"Authorization": "Bearer business-admin-token"},
  )

  assert client.get("/capabilities").status_code == 200
  assert client.get("/operator/capabilities").status_code == 403
  assert client.get("/training-stats").status_code == 403
  assert client.put("/providers/local_model", json={"enabled": False}).status_code == 403


def test_capabilities_report_ocr_unavailable_without_host_tesseract(real_model_bundle):
  client = build_real_client(real_model_bundle, tesseract_available=False)

  capabilities = client.get("/capabilities")

  assert capabilities.status_code == 200
  assert capabilities.json()["classification"] is True
  assert capabilities.json()["ocr"] is False


def test_cors_allows_local_frontend_origins(real_model_bundle):
  client = build_real_client(real_model_bundle)

  response = client.options(
    "/analyze-langchain",
    headers={
      "Origin": "http://127.0.0.1:5173",
      "Access-Control-Request-Method": "POST",
    },
  )

  assert response.status_code == 200
  assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"


def test_classify_and_langchain_analysis(real_model_bundle):
  client = build_real_client(real_model_bundle)

  classify = client.post("/classify", json={"title": "critical production incident"})
  analyze = client.post("/analyze-langchain", json={"task": "exercise twice a week", "language": "pl"})

  assert classify.status_code == 200
  assert classify.json()["quadrant"] == 0
  assert classify.json()["method"] == "local-minilm"
  assert analyze.status_code == 200
  assert analyze.json()["langchain_analysis"]["quadrant"] == 2
  assert analyze.json()["langchain_analysis"]["method"] == "local-analysis"
  assert analyze.json()["rag_classification"]["quadrant_name"] == "Zaplanuj"


def test_training_management_endpoints(real_model_bundle):
  client = build_real_client(real_model_bundle)

  add = client.post("/add-example", data={"text": "review invoices", "quadrant": 1})
  feedback = client.post(
    "/learn-feedback",
    data={
      "task": "exercise twice a week",
      "predicted_quadrant": 1,
      "correct_quadrant": 2,
    },
  )
  stats = client.get("/training-stats")
  examples = client.get("/examples/2", params={"limit": 5})
  retrain = client.post("/retrain", data={"preserve_experience": "false"})
  clear = client.delete("/training-data", params={"keep_defaults": "false"})

  assert add.status_code == 200
  assert feedback.status_code == 200
  assert stats.status_code == 200
  assert stats.json()["model_ready"] is True
  assert examples.status_code == 200
  assert retrain.json()["preserve_experience"] is False
  assert retrain.json()["preserve_experience_deprecated"] is True
  assert retrain.json()["examples_seen"] >= len(real_model_bundle["records"])
  assert clear.json()["remaining_examples"] == 0


def test_production_can_disable_mutating_training_endpoints(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    ai_management_enabled=False,
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(settings=settings, store=store, local_model=FakeLocalModel())
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service),
    headers={"Authorization": "Bearer test-admin-token"},
  )
  original_records = store.load()

  response = client.post("/add-example", data={"text": "poison", "quadrant": 0})

  assert response.status_code == 403
  assert response.json()["error"] == "Training management is disabled in this environment."
  assert store.load() == original_records


def test_ocr_feedback_endpoint_batches_examples_and_retrains(tmp_path: Path):
  local_model = FakeLocalModel()
  client = build_client(tmp_path, local_model=local_model)

  feedback = client.post(
    "/learn-ocr-feedback",
    json={
      "tasks": [
        {"task": "urgent outage", "quadrant": 0},
        {"task": "prepare roadmap", "quadrant": 2},
      ],
      "retrain": True,
    },
  )
  stats = client.get("/training-stats")

  assert feedback.status_code == 200
  assert feedback.json()["examples_added"] == 2
  assert feedback.json()["retrained"] is True
  assert feedback.json()["training"]["examples_seen"] == stats.json()["total_examples"]
  assert local_model.train_calls


def test_ocr_feedback_endpoint_rejects_empty_batches(tmp_path: Path):
  client = build_client(tmp_path)

  feedback = client.post("/learn-ocr-feedback", json={"tasks": []})

  assert feedback.status_code == 400
  assert feedback.json()["error"] == "At least one accepted OCR task is required."


def test_batch_and_extract_routes(real_model_bundle):
  client = build_real_client(real_model_bundle)

  batch = client.post("/batch-analyze", json={"tasks": ["critical production incident", "exercise twice a week"]})
  upload = client.post(
    "/extract-tasks-from-image",
    files={"file": ("tasks.txt", b"critical production incident\nexercise twice a week\n", "text/plain")},
  )

  assert batch.status_code == 200
  assert batch.json()["summary"]["total_tasks"] == 2
  assert upload.status_code == 200
  assert upload.json()["summary"]["total_tasks"] == 2
  assert upload.json()["ocr"]["method"] == "plain-text"
  assert upload.json()["classified_tasks"][0]["similar_examples_used"] >= 1
  assert upload.json()["classified_tasks"][0]["top_similar_examples"]


def test_extract_route_maps_unsafe_image_to_safe_4xx(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(
    settings=settings,
    store=store,
    local_model=FakeLocalModel(),
    ocr_runner=lambda *_args, **_kwargs: "must not run",
  )
  service._tesseract_available = lambda: True  # type: ignore[method-assign]
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service),
    headers={"Authorization": "Bearer test-admin-token"},
    raise_server_exceptions=False,
  )
  payload = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32

  response = client.post(
    "/extract-tasks-from-image",
    files={"file": ("unsafe.png", payload, "image/png")},
  )

  assert response.status_code == 422
  assert response.json() == {"error": "invalid_image"}


def test_extract_route_maps_excessive_image_dimensions_to_413(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    ocr_max_pixels=8,
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(
    settings=settings,
    store=store,
    local_model=FakeLocalModel(),
    ocr_runner=lambda *_args, **_kwargs: "must not run",
  )
  service._tesseract_available = lambda: True  # type: ignore[method-assign]
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service),
    headers={"Authorization": "Bearer test-admin-token"},
  )
  image = Image.new("RGB", (4, 4), "white")
  buffer = BytesIO()
  image.save(buffer, format="PNG")

  response = client.post(
    "/extract-tasks-from-image",
    files={"file": ("oversized.png", buffer.getvalue(), "image/png")},
  )

  assert response.status_code == 413
  assert response.json() == {"error": "image_dimensions_exceeded"}


def test_client_facing_payloads_keep_the_fields_used_by_web_and_mobile(real_model_bundle):
  client = build_real_client(real_model_bundle)

  classify = client.post("/classify", json={"title": "critical production incident"})
  analyze = client.post("/analyze-langchain", json={"task": "exercise twice a week", "language": "pl"})
  batch = client.post("/batch-analyze", json={"tasks": ["critical production incident", "exercise twice a week"]})
  upload = client.post(
    "/extract-tasks-from-image",
    files={"file": ("tasks.txt", b"critical production incident\nexercise twice a week\n", "text/plain")},
  )

  classification_payload = classify.json()
  analysis_payload = analyze.json()
  batch_payload = batch.json()
  upload_payload = upload.json()

  assert classify.status_code == 200
  assert {"task", "urgent", "important", "quadrant", "quadrant_name", "method"} <= set(classification_payload)

  assert analyze.status_code == 200
  assert {"task", "langchain_analysis", "rag_classification"} <= set(analysis_payload)
  assert {"quadrant", "reasoning", "method"} <= set(analysis_payload["langchain_analysis"])
  assert {"quadrant", "quadrant_name"} <= set(analysis_payload["rag_classification"])

  assert batch.status_code == 200
  assert {"batch_results", "summary"} <= set(batch_payload)
  assert batch_payload["summary"]["total_tasks"] == 2
  assert {"task", "analyses"} <= set(batch_payload["batch_results"][0])
  assert {"rag", "langchain"} <= set(batch_payload["batch_results"][0]["analyses"])

  assert upload.status_code == 200
  assert {"classified_tasks", "summary"} <= set(upload_payload)
  assert upload_payload["summary"]["total_tasks"] == 2
  assert {"text", "quadrant", "quadrant_name", "confidence"} <= set(upload_payload["classified_tasks"][0])


def test_provider_toggle_endpoint_disables_and_reenables_runtime_features(real_model_bundle):
  client = build_real_client(real_model_bundle)

  disable_local_model = client.put("/providers/local_model", json={"enabled": False})
  disabled_classify = client.post("/classify", json={"title": "critical production incident"})
  disable_tesseract = client.put("/providers/tesseract", json={"enabled": False})
  disabled_image_upload = client.post(
    "/extract-tasks-from-image",
    files={"file": ("tasks.png", b"fake-image", "image/png")},
  )
  text_upload = client.post(
    "/extract-tasks-from-image",
    files={"file": ("tasks.txt", b"critical production incident\n", "text/plain")},
  )
  enable_local_model = client.put("/providers/local_model", json={"enabled": True})
  enabled_classify = client.post("/classify", json={"title": "critical production incident"})
  enable_tesseract = client.put("/providers/tesseract", json={"enabled": True})

  assert disable_local_model.status_code == 200
  assert disable_local_model.json()["enabled"] is False
  assert disable_local_model.json()["reason"] == "Disabled in AI management."
  assert disabled_classify.status_code == 503
  assert disabled_classify.json()["code"] == "provider_disabled"
  assert disable_tesseract.status_code == 200
  assert disabled_image_upload.status_code == 503
  assert disabled_image_upload.json()["code"] == "provider_disabled"
  assert text_upload.status_code == 503
  assert text_upload.json()["code"] == "provider_disabled"
  assert enable_local_model.status_code == 200
  assert enable_local_model.json()["active"] is True
  assert enabled_classify.status_code == 200
  assert enable_tesseract.status_code == 200


def test_error_shapes_are_json(real_model_bundle):
  client = build_real_client(real_model_bundle)

  missing = client.post("/batch-analyze", json={"tasks": []})
  quadrant = client.get("/examples/9")

  assert missing.status_code == 400
  assert missing.json()["error"] == "At least one task is required."
  assert quadrant.status_code == 404
  assert quadrant.json()["error"] == "Quadrant not found."


def test_model_not_ready_errors_return_503(tmp_path: Path):
  client = build_client(tmp_path, local_model=FakeLocalModel(fail_predict=True))

  response = client.post("/classify", json={"title": "urgent client deadline"})

  assert response.status_code == 503
  assert response.json()["code"] == "model_not_ready"


def test_capabilities_stay_available_when_startup_raises_generic_error(tmp_path: Path):
  client = build_client(tmp_path, local_model=FakeLocalModel(startup_error=RuntimeError("corrupt artifacts")))

  capabilities = client.get("/capabilities")
  operator_capabilities = client.get("/operator/capabilities")
  stats = client.get("/training-stats")

  assert capabilities.status_code == 200
  assert capabilities.json()["classification"] is False
  assert operator_capabilities.json()["providers"]["local_model"] is False
  assert operator_capabilities.json()["provider_controls"]["local_model"]["available"] is False
  assert stats.status_code == 200
  assert stats.json()["model_ready"] is False
  assert stats.json()["model_error"] == "corrupt artifacts"


def test_knowledge_capabilities_are_routed_by_rag_runtime_not_classifier_readiness(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_retrieval_enabled=True,
    rag_generation_enabled=True,
    rag_response_enabled=True,
  )
  store = TrainingStore(settings.training_data_path)
  service = QuadrantAIService(
    settings=settings,
    store=store,
    local_model=FakeLocalModel(startup_error=RuntimeError("classifier offline")),
  )
  client = TestClient(
    create_app(settings=settings, store=store, ai_service=service, rag_service=FakeRagService()),
    headers={"Authorization": "Bearer test-api-token"},
  )

  capabilities = client.get("/capabilities")

  assert capabilities.status_code == 200
  assert capabilities.json()["classification"] is False
  assert capabilities.json()["knowledge_retrieval"] is True
  assert capabilities.json()["retrieval_augmented_generation"] is True
