import json
from pathlib import Path

from app.rag.models import AccessScope, RetrievalQuery
from app.rag.task049_evaluation import (
  build_candidates,
  confidence_features,
  IdentifierEvidenceGateRetriever,
  QueryThresholdRetriever,
  build_task050_candidates,
)
from app.rag.models import RetrievalHit


class RecordingRetriever:
  def __init__(self):
    self.queries = []

  def retrieve(self, query):
    self.queries.append(query)
    return []


class FixedRetriever:
  def __init__(self, hits):
    self.hits = hits

  def retrieve(self, _query):
    return self.hits


def hit(document_id, *, title, text, score=0.7):
  return RetrievalHit(
    chunk_id=f"chunk-{document_id}",
    document_id=document_id,
    text=text,
    score=score,
    source_uri=f"knowledge://{document_id}",
    title=title,
    tenant_id="tenant",
    project_id="project",
    owner_id="user",
    embedding_version="bge-m3-v1",
    content_version="v1",
  )


def query():
  return RetrievalQuery(
    text="synthetic query",
    scope=AccessScope(tenant_id="tenant", user_id="user", project_ids=["project"]),
    project_id="project",
    limit=5,
  )


def test_query_threshold_wrapper_overrides_only_score_threshold():
  delegate = RecordingRetriever()
  wrapped = QueryThresholdRetriever(delegate, 0.35)

  wrapped.retrieve(query())

  assert delegate.queries == [query().model_copy(update={"score_threshold": 0.35})]


def test_identifier_evidence_gate_rejects_semantic_substitutes_and_preserves_supported_hits():
  unsupported = IdentifierEvidenceGateRetriever(FixedRetriever([
    hit("other", title="Procedure PL-OTHER-7", text="Similar recovery workflow."),
  ]))
  supported_hits = [
    hit("expected", title="Procedure PL-AB12-X", text="Approved recovery workflow."),
    hit("context", title="General recovery", text="Supporting context."),
  ]
  supported = IdentifierEvidenceGateRetriever(FixedRetriever(supported_hits))
  unstructured = IdentifierEvidenceGateRetriever(FixedRetriever(supported_hits))

  assert unsupported.retrieve(query().model_copy(update={"text": "Find PL-AB12-X."})) == []
  assert supported.retrieve(query().model_copy(update={"text": "Find PL-AB12-X."})) == supported_hits
  assert unstructured.retrieve(query().model_copy(update={"text": "How do I recover a backup?"})) == supported_hits


def test_identifier_evidence_gate_requires_every_distinct_structured_identifier():
  retriever = IdentifierEvidenceGateRetriever(FixedRetriever([
    hit("first", title="Procedure EN-AB12-X", text="Input requirements."),
    hit("wrong-second", title="Procedure EN-OTHER-Y", text="Output verification."),
  ]))

  assert retriever.retrieve(query().model_copy(
    update={"text": "Compare EN-AB12-X with EN-CD34-Y."}
  )) == []


def test_task049_builds_only_dense_rrf_and_score_aware_candidates_without_reranker():
  dense = RecordingRetriever()
  lexical = RecordingRetriever()

  candidates, configurations = build_candidates(dense, lexical)

  assert set(candidates) == {
    "bge-m3-dense-t55", "bge-m3-dense-t65", "bge-m3-dense-t75", "bge-m3-dense-t85",
    "bge-m3-rrf-t55", "bge-m3-rrf-t65", "bge-m3-rrf-t75", "bge-m3-rrf-t85",
    *{
      f"bge-m3-score-fusion-d{dense_weight}-l{lexical_weight}-t{threshold}"
      for dense_weight, lexical_weight in ((2, 1), (1, 1), (1, 2))
      for threshold in (55, 65, 75, 85)
    },
  }
  assert set(candidates) == set(configurations)
  assert all("reranker" not in configuration for configuration in configurations.values())
  assert configurations["bge-m3-score-fusion-d2-l1-t65"] == {
    "strategy": "hybrid-score-v1",
    "score_threshold": 0.65,
    "fusion_mode": "dbsf",
    "dense_weight": 2.0,
    "lexical_weight": 1.0,
    "rrf_k": None,
  }


def test_frozen_policy_exactly_matches_candidate_space():
  policy_path = (
    Path(__file__).parents[1] / "evaluation" / "retrieval-task049-v1" / "policy-v2.json"
  )
  policy = json.loads(policy_path.read_text(encoding="utf-8"))

  _, configurations = build_candidates(RecordingRetriever(), RecordingRetriever())

  assert policy["candidates"] == configurations
  assert policy["sparse_trigger"] == "round_2_no_candidate_after_abstention_calibration"
  assert policy["global"]["no_answer_accuracy_min"] == 1.0


def test_task050_candidate_combines_source_native_confidence_and_identifier_evidence():
  candidates, configurations = build_task050_candidates(
    RecordingRetriever(), RecordingRetriever()
  )

  assert set(candidates) == {"bge-m3-dbsf-d2-l1-confidence-id-v1"}
  assert configurations == {
    "bge-m3-dbsf-d2-l1-confidence-id-v1": {
      "strategy": "hybrid-score-confidence-v1",
      "score_threshold": 0.40,
      "fusion_mode": "dbsf",
      "dense_weight": 2.0,
      "lexical_weight": 1.0,
      "rrf_k": None,
      "identifier_evidence_required": True,
      "confidence": {
        "dense_top_min": 0.40,
        "strong_dense_top_min": 0.61,
        "dense_margin_min": 0.05,
        "lexical_top_min": 5.0,
      },
    }
  }


def test_confidence_features_preserve_dense_margin_and_lexical_agreement():
  assert confidence_features(
    [("doc-a", 0.72), ("doc-b", 0.51), ("doc-c", 0.4)],
    [("doc-a", 3.2), ("doc-d", 1.4)],
  ) == {
    "dense_top": 0.72,
    "dense_margin": 0.21,
    "lexical_top": 3.2,
    "dense_lexical_agreement": True,
  }
  assert confidence_features([("doc-z", 0.48)], []) == {
    "dense_top": 0.48,
    "dense_margin": 0.48,
    "lexical_top": None,
    "dense_lexical_agreement": False,
  }
