from app.rag.application import RagAnalysisService
from app.rag.models import AccessScope, GenerationResult, RetrievalHit


class StubRetriever:
  def __init__(self, hits):
    self.hits = hits
    self.queries = []

  def retrieve(self, query):
    self.queries.append(query)
    return self.hits


class StubGenerator:
  def __init__(self, result=None, error=None):
    self.result = result
    self.error = error
    self.requests = []

  def generate(self, request):
    self.requests.append(request)
    if self.error:
      raise self.error
    return self.result


class StubFallback:
  def classify_task(self, task, use_rag=False):
    return {"quadrant": 1, "quadrant_name": "Delegate", "confidence": 0.61}


def test_rag_analysis_returns_only_acl_scoped_citations():
  hits = [
    RetrievalHit(
      chunk_id="chunk-1",
      document_id="doc-1",
      text="The roadmap is important but has no immediate deadline.",
      score=0.88,
      source_uri="task://roadmap",
      title="Roadmap",
      tenant_id="tenant-a",
      project_id="project-1",
      embedding_version="minilm-v1",
      content_version="v1",
    )
  ]
  generator = StubGenerator(
    GenerationResult(
      quadrant=2,
      confidence=0.82,
      explanation="The task is important and not urgent.",
      cited_chunk_ids=["chunk-1"],
    )
  )
  service = RagAnalysisService(StubRetriever(hits), generator, StubFallback())

  result = service.analyze(
    "Prepare strategic roadmap",
    AccessScope(tenant_id="tenant-a", user_id="user-1", project_ids=["project-1"]),
  )

  assert result.mode == "rag"
  assert result.quadrant == 2
  assert result.citations[0].chunk_id == "chunk-1"
  assert result.citations[0].source_uri == "task://roadmap"
  assert result.retrieval.hit_count == 1


def test_rag_analysis_rejects_generator_citations_not_present_in_context():
  hit = RetrievalHit(
    chunk_id="allowed",
    document_id="doc-1",
    text="Known context",
    score=0.8,
    source_uri="knowledge://1",
    title="Known",
    tenant_id="tenant-a",
    embedding_version="minilm-v1",
    content_version="v1",
  )
  generator = StubGenerator(
    GenerationResult(
      quadrant=0,
      confidence=0.9,
      explanation="Unsupported claim",
      cited_chunk_ids=["invented"],
    )
  )
  service = RagAnalysisService(StubRetriever([hit]), generator, StubFallback())

  result = service.analyze("Task", AccessScope(tenant_id="tenant-a", user_id="user-1"))

  assert result.mode == "fallback"
  assert result.fallback_reason == "invalid_citations"
  assert result.citations == []


def test_rag_analysis_falls_back_when_retrieval_has_no_grounding():
  service = RagAnalysisService(StubRetriever([]), StubGenerator(), StubFallback())

  result = service.analyze("Task", AccessScope(tenant_id="tenant-a", user_id="user-1"))

  assert result.mode == "fallback"
  assert result.quadrant == 1
  assert result.fallback_reason == "no_retrieval_hits"


def test_rag_analysis_falls_back_when_generation_provider_is_unavailable():
  hit = RetrievalHit(
    chunk_id="chunk-1",
    document_id="doc-1",
    text="Known context",
    score=0.8,
    source_uri="knowledge://1",
    title="Known",
    tenant_id="tenant-a",
    embedding_version="minilm-v1",
    content_version="v1",
  )
  service = RagAnalysisService(
    StubRetriever([hit]),
    StubGenerator(error=TimeoutError("vLLM timeout")),
    StubFallback(),
  )

  result = service.analyze("Task", AccessScope(tenant_id="tenant-a", user_id="user-1"))

  assert result.mode == "fallback"
  assert result.fallback_reason == "generation_unavailable"


def test_knowledge_search_returns_retrieval_citations_without_generation():
  hit = RetrievalHit(
    chunk_id="chunk-1",
    document_id="doc-1",
    text="Known project context",
    score=0.8,
    source_uri="knowledge://1",
    title="Known",
    tenant_id="tenant-a",
    project_id="project-1",
    embedding_version="minilm-v1",
    content_version="v1",
  )
  retriever = StubRetriever([hit])
  service = RagAnalysisService(retriever, StubGenerator(), StubFallback())

  result = service.search(
    "project context",
    AccessScope(tenant_id="tenant-a", user_id="user-1", project_ids=["project-1"]),
    limit=5,
  )

  assert result["citations"][0].chunk_id == "chunk-1"
  assert result["answer"] is None
  assert retriever.queries[0].limit == 5
