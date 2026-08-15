import json
from pathlib import Path

from app.rag.models import AccessScope, RetrievalQuery
from app.rag.task049_evaluation import build_candidates, QueryThresholdRetriever


class RecordingRetriever:
  def __init__(self):
    self.queries = []

  def retrieve(self, query):
    self.queries.append(query)
    return []


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


def test_task049_builds_only_dense_rrf_and_score_aware_candidates_without_reranker():
  dense = RecordingRetriever()
  lexical = RecordingRetriever()

  candidates, configurations = build_candidates(dense, lexical)

  assert set(candidates) == {
    "bge-m3-dense-t20", "bge-m3-dense-t35", "bge-m3-dense-t50",
    "bge-m3-rrf-t20", "bge-m3-rrf-t35", "bge-m3-rrf-t50",
    *{
      f"bge-m3-score-fusion-d{dense_weight}-l{lexical_weight}-t{threshold}"
      for dense_weight, lexical_weight in ((2, 1), (1, 1), (1, 2))
      for threshold in (20, 35, 50)
    },
  }
  assert set(candidates) == set(configurations)
  assert all("reranker" not in configuration for configuration in configurations.values())
  assert configurations["bge-m3-score-fusion-d2-l1-t35"] == {
    "strategy": "hybrid-score-v1",
    "score_threshold": 0.35,
    "fusion_mode": "dbsf",
    "dense_weight": 2.0,
    "lexical_weight": 1.0,
    "rrf_k": None,
  }


def test_frozen_policy_exactly_matches_candidate_space():
  policy_path = (
    Path(__file__).parents[1] / "evaluation" / "retrieval-task049-v1" / "policy.json"
  )
  policy = json.loads(policy_path.read_text(encoding="utf-8"))

  _, configurations = build_candidates(RecordingRetriever(), RecordingRetriever())

  assert policy["candidates"] == configurations
  assert policy["sparse_trigger"] == "calibration_no_candidate"
  assert policy["global"]["no_answer_accuracy_min"] == 1.0
