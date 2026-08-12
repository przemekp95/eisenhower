import pytest

from app.rag.hybrid import (
  CanonicalBm25Retriever,
  CandidateScopeViolation,
  HybridRetrievalCore,
  HybridRetriever,
  RerankerUnavailable,
)
from app.rag.canonical import CanonicalDocumentState
from app.rag.models import AccessScope, RetrievalHit, RetrievalQuery, SourceDocument


def query(text="TASK-013 zatwierdzenie", *, limit=3, project_id="project-1"):
  return RetrievalQuery(
    text=text,
    limit=limit,
    project_id=project_id,
    score_threshold=-1.0,
    scope=AccessScope(
      tenant_id="tenant-a",
      user_id="user-1",
      project_ids=["project-1"],
    ),
  )


def hit(chunk_id, text, *, score, document_id=None, tenant_id="tenant-a", project_id="project-1"):
  return RetrievalHit(
    chunk_id=chunk_id,
    document_id=document_id or f"doc-{chunk_id}",
    text=text,
    score=score,
    source_uri=f"knowledge://{chunk_id}",
    title=f"Title {chunk_id}",
    tenant_id=tenant_id,
    project_id=project_id,
    owner_id="user-1",
    embedding_version="minilm-v1",
    content_version="v1",
  )


def candidates():
  return [
    hit("semantic", "Ogólne zatwierdzenie oceny jakości.", score=0.99),
    hit("noise", "Dokument o wdrożeniu Androida.", score=0.90),
    hit("exact", "TASK-013 zatwierdzenie jakości retrievalu.", score=0.70),
  ]


class DenseRetriever:
  def __init__(self, hits):
    self.hits = hits
    self.queries = []

  def retrieve(self, retrieval_query):
    self.queries.append(retrieval_query)
    return self.hits[:retrieval_query.limit]


class CanonicalStore:
  def __init__(self, documents, states):
    self.documents = documents
    self.states = states
    self.project_queries = []

  def project_documents(self, tenant_id, project_id=None):
    self.project_queries.append((tenant_id, project_id))
    return list(self.documents)

  def retrieval_state(self, tenant_id, document_id):
    return self.states.get((tenant_id, document_id))


def document(
  document_id,
  *,
  text,
  title=None,
  tenant_id="tenant-a",
  project_id="project-1",
  content_version="v2",
  acl_subjects=None,
  deleted=False,
):
  return SourceDocument(
    document_id=document_id,
    tenant_id=tenant_id,
    project_id=project_id,
    owner_id="user-1",
    source_type="note",
    source_uri=f"note://{document_id}",
    title=title or f"Title {document_id}",
    text=text,
    content_version=content_version,
    source_sequence=2,
    acl_subjects=acl_subjects or ["user:user-1", f"project:{project_id}"],
    deleted=deleted,
  )


def test_hybrid_can_recall_a_canonical_lexical_candidate_that_dense_missed():
  exact = document("exact-doc", text="TASK-013 zatwierdzenie jakości retrievalu")
  store = CanonicalStore(
    [exact],
    {("tenant-a", "exact-doc"): CanonicalDocumentState(exact, projection_pending=False)},
  )
  dense = DenseRetriever([
    hit("semantic", "Ogólne zatwierdzenie oceny jakości.", score=0.99),
    hit("noise", "Dokument o wdrożeniu Androida.", score=0.90),
  ])
  lexical = CanonicalBm25Retriever(
    store,
    embedding_version="minilm-v1",
  )
  retriever = HybridRetriever(dense, lexical, rrf_k=60)

  ranked = retriever.retrieve(query(limit=2))

  assert "exact-doc" not in {item.document_id for item in dense.hits}
  assert [item.document_id for item in ranked] == ["exact-doc", "doc-semantic"]
  assert dense.queries[0].limit > 2
  assert store.project_queries == [("tenant-a", "project-1")]


def test_lexical_retriever_enforces_pending_tombstone_version_acl_and_scope_boundary():
  old = document("stale", text="old content", content_version="v1")
  current = document("stale", text="currenttoken approved content", content_version="v2")
  pending = document("pending", text="currenttoken pending")
  deleted = document("deleted", text="", title="[deleted]", deleted=True)
  foreign_acl = document(
    "foreign-acl", text="currenttoken private", acl_subjects=["user:other"]
  )
  foreign_project = document(
    "foreign-project", text="currenttoken other project", project_id="project-2"
  )
  foreign_tenant = document(
    "foreign-tenant", text="currenttoken other tenant", tenant_id="tenant-b"
  )
  states = {
    ("tenant-a", "stale"): CanonicalDocumentState(current, projection_pending=False),
    ("tenant-a", "pending"): CanonicalDocumentState(pending, projection_pending=True),
    ("tenant-a", "deleted"): CanonicalDocumentState(deleted, projection_pending=False),
    ("tenant-a", "foreign-acl"): CanonicalDocumentState(foreign_acl, projection_pending=False),
    ("tenant-a", "foreign-project"): CanonicalDocumentState(
      foreign_project, projection_pending=False
    ),
    ("tenant-a", "foreign-tenant"): CanonicalDocumentState(
      foreign_tenant, projection_pending=False
    ),
  }
  store = CanonicalStore(
    [old, pending, deleted, foreign_acl, foreign_project, foreign_tenant],
    states,
  )
  retriever = CanonicalBm25Retriever(store, embedding_version="minilm-v1")

  ranked = retriever.retrieve(query("currenttoken", limit=10))

  assert [(item.document_id, item.text, item.content_version) for item in ranked] == [
    ("stale", "currenttoken approved content", "v2")
  ]


def test_lexical_canonical_store_failure_propagates_instead_of_falling_back():
  class UnavailableStore:
    def project_documents(self, _tenant_id, _project_id=None):
      raise RuntimeError("canonical store unavailable")

  retriever = CanonicalBm25Retriever(UnavailableStore(), embedding_version="minilm-v1")

  with pytest.raises(RuntimeError, match="canonical store unavailable"):
    retriever.retrieve(query())


def test_bm25_and_dense_ranks_are_fused_with_equal_rrf_contributions():
  ranked = HybridRetrievalCore(
    rrf_k=60,
    dense_rrf_weight=1.0,
    lexical_rrf_weight=1.0,
  ).rank(query(), candidates())

  assert [item.chunk_id for item in ranked] == ["semantic", "exact", "noise"]
  assert ranked[0].score == pytest.approx((1 / 61) + (1 / 62))
  assert ranked[1].score == pytest.approx((1 / 63) + (1 / 61))


def test_weighted_rrf_can_prioritize_the_lexical_ranking():
  dense_first = hit("dense-first", "semantic match", score=0.9)
  lexical_first = hit("lexical-first", "exact identifier", score=0.8)
  dense = [dense_first, lexical_first]
  lexical = [
    lexical_first.model_copy(update={"score": 0.9}),
    dense_first.model_copy(update={"score": 0.8}),
  ]

  ranked = HybridRetrievalCore(
    rrf_k=10,
    dense_rrf_weight=1.0,
    lexical_rrf_weight=2.0,
  ).rank(query(limit=2), dense, lexical)

  assert [item.chunk_id for item in ranked] == ["lexical-first", "dense-first"]
  assert ranked[0].score == pytest.approx((1 / 12) + (2 / 11))


def test_distinct_documents_are_ranked_before_additional_chunks_from_the_same_document():
  first = hit("doc-a-1", "first", score=0.9, document_id="doc-a")
  second = hit("doc-a-2", "second", score=0.8, document_id="doc-a")
  distinct = hit("doc-b-1", "third", score=0.7, document_id="doc-b")

  ranked = HybridRetrievalCore().rank(
    query(limit=3),
    [first, second, distinct],
    [first, second, distinct],
  )

  assert [(item.chunk_id, item.document_id) for item in ranked] == [
    ("doc-a-1", "doc-a"),
    ("doc-b-1", "doc-b"),
    ("doc-a-2", "doc-a"),
  ]
  assert ranked[1].tenant_id == "tenant-a"
  assert ranked[1].project_id == "project-1"


def test_fielded_bm25_can_give_titles_more_weight_than_body_text():
  title_match = hit("title-match", "unrelated body", score=0.0).model_copy(
    update={"title": "FastAPI boundary"}
  )
  body_match = hit("body-match", "FastAPI boundary", score=0.0).model_copy(
    update={"title": "Unrelated title"}
  )

  scores = HybridRetrievalCore._bm25_scores(
    "FastAPI",
    [title_match, body_match],
    title_weight=2.0,
    text_weight=1.0,
  )

  assert scores["title-match"] > scores["body-match"]


def test_ties_are_deterministic_and_preserve_canonical_identifiers():
  tied = [
    hit("chunk-b", "brak dopasowania", score=0.5, document_id="doc-b"),
    hit("chunk-a", "również brak", score=0.5, document_id="doc-a"),
  ]
  core = HybridRetrievalCore(rrf_k=20)

  first = core.rank(query("nieobecne słowo", limit=2), tied)
  second = core.rank(query("nieobecne słowo", limit=2), list(reversed(tied)))

  assert [(item.chunk_id, item.document_id) for item in first] == [
    ("chunk-a", "doc-a"),
    ("chunk-b", "doc-b"),
  ]
  assert [(item.chunk_id, item.document_id) for item in second] == [
    ("chunk-a", "doc-a"),
    ("chunk-b", "doc-b"),
  ]


@pytest.mark.parametrize(
  "candidate",
  [
    hit("foreign-tenant", "TASK-013", score=0.9, tenant_id="tenant-b"),
    hit("foreign-project", "TASK-013", score=0.9, project_id="project-2"),
  ],
)
def test_scope_mismatch_fails_closed_instead_of_bypassing_canonical_acl_boundary(candidate):
  with pytest.raises(CandidateScopeViolation):
    HybridRetrievalCore().rank(query(), [candidate])


class RecordingReranker:
  def __init__(self, scores=None, error=None):
    self.scores = scores
    self.error = error
    self.received = None

  def score(self, query_text, ranked_candidates):
    self.received = (query_text, ranked_candidates)
    if self.error is not None:
      raise self.error
    return self.scores


def test_optional_reranker_receives_only_the_bounded_fused_prefix():
  reranker = RecordingReranker(scores=[0.1, 0.9])
  core = HybridRetrievalCore(reranker=reranker, reranker_candidate_limit=2)

  ranked = core.rank(query(), candidates())

  assert reranker.received is not None
  assert reranker.received[0] == "TASK-013 zatwierdzenie"
  assert [item.chunk_id for item in reranker.received[1]] == ["semantic", "exact"]
  assert [item.chunk_id for item in ranked] == ["exact", "semantic", "noise"]


def test_disabled_reranker_returns_the_fused_order():
  ranked = HybridRetrievalCore(reranker=None).rank(query(), candidates())

  assert [item.chunk_id for item in ranked] == ["semantic", "exact", "noise"]


def test_enabled_reranker_failure_is_typed_and_never_silently_swaps_or_falls_back():
  reranker = RecordingReranker(error=RuntimeError("provider unavailable"))

  with pytest.raises(RerankerUnavailable) as raised:
    HybridRetrievalCore(reranker=reranker).rank(query(), candidates())

  assert isinstance(raised.value.__cause__, RuntimeError)
  assert str(raised.value) == "reranker provider failed"


@pytest.mark.parametrize("scores", [None, [0.1], [0.1, float("nan")]])
def test_invalid_reranker_output_fails_closed(scores):
  reranker = RecordingReranker(scores=scores)

  with pytest.raises(RerankerUnavailable):
    HybridRetrievalCore(reranker=reranker, reranker_candidate_limit=2).rank(
      query(),
      candidates(),
    )


def test_non_sequence_reranker_output_is_mapped_to_the_typed_failure():
  reranker = RecordingReranker(scores=iter([0.1, 0.9]))

  with pytest.raises(RerankerUnavailable):
    HybridRetrievalCore(reranker=reranker, reranker_candidate_limit=2).rank(
      query(),
      candidates(),
    )


@pytest.mark.parametrize(
  "kwargs",
  [
    {"rrf_k": 0},
    {"dense_rrf_weight": 0},
    {"dense_rrf_weight": 10.1},
    {"lexical_rrf_weight": 0},
    {"lexical_rrf_weight": 10.1},
    {"reranker_candidate_limit": 0},
    {"reranker_candidate_limit": 21},
  ],
)
def test_configuration_bounds_are_fail_closed(kwargs):
  with pytest.raises(ValueError):
    HybridRetrievalCore(**kwargs)


@pytest.mark.parametrize(
  "kwargs",
  [
    {"title_weight": 0},
    {"title_weight": 10.1},
    {"text_weight": 0},
    {"text_weight": 10.1},
  ],
)
def test_bm25_field_weight_configuration_is_bounded(kwargs):
  with pytest.raises(ValueError):
    CanonicalBm25Retriever(
      CanonicalStore([], {}),
      embedding_version="minilm-v1",
      **kwargs,
    )
