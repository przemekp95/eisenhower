from app.rag.application import RagAnalysisService
from app.rag.adapters import QdrantIngestionAdapter
from app.rag.models import AccessScope, ChunkRecord, GenerationResult, RetrievalHit
from haystack import Document
from haystack_integrations.document_stores.qdrant import QdrantDocumentStore

from .comparison import HaystackAnalysisAdapter


class RecordingRetriever:
  def __init__(self, hits):
    self.hits = hits
    self.queries = []

  def retrieve(self, query):
    self.queries.append(query)
    return self.hits


class FixedGenerator:
  def generate(self, request):
    return GenerationResult(
      quadrant=2,
      confidence=0.91,
      explanation="Grounded in the project policy.",
      cited_chunk_ids=[request.context[0].chunk_id],
    )


class FixedFallback:
  def classify_task(self, task, use_rag=False):
    return {"quadrant": 1, "quadrant_name": "Delegate", "confidence": 0.6}


def _hit():
  return RetrievalHit(
    chunk_id="chunk-1",
    document_id="document-1",
    text="Roadmap work is important but not urgent.",
    score=0.92,
    source_uri="eisenhower://project/alpha/context",
    title="Project alpha",
    tenant_id="tenant-a",
    project_id="alpha",
    owner_id="user-a",
    embedding_version="minilm-v1",
    content_version="v1",
    source_type="project_context",
  )


def _scope():
  return AccessScope(
    tenant_id="tenant-a",
    user_id="user-a",
    project_ids=["alpha"],
    roles=["member"],
  )


def test_haystack_pipeline_matches_reference_domain_result():
  reference_retriever = RecordingRetriever([_hit()])
  haystack_retriever = RecordingRetriever([_hit()])
  reference = RagAnalysisService(reference_retriever, FixedGenerator(), FixedFallback())
  candidate = HaystackAnalysisAdapter(haystack_retriever, FixedGenerator(), FixedFallback())

  expected = reference.analyze("Prepare roadmap", _scope())
  actual = candidate.analyze("Prepare roadmap", _scope())

  assert actual == expected
  assert actual.__class__.__module__ == "app.rag.models"


def test_haystack_component_preserves_tenant_project_and_acl_scope():
  retriever = RecordingRetriever([_hit()])
  candidate = HaystackAnalysisAdapter(retriever, FixedGenerator(), FixedFallback())

  candidate.analyze("Prepare roadmap", _scope())

  query = retriever.queries[0]
  assert query.scope.tenant_id == "tenant-a"
  assert query.scope.project_ids == ["alpha"]
  assert query.scope.acl_subjects == [
    "tenant:tenant-a",
    "user:user-a",
    "project:alpha",
    "role:member",
  ]


def test_haystack_candidate_uses_reference_fallback_for_invalid_citations():
  class InvalidGenerator:
    def generate(self, request):
      return GenerationResult(
        quadrant=0,
        confidence=0.99,
        explanation="Unsupported",
        cited_chunk_ids=["foreign-tenant-chunk"],
      )

  candidate = HaystackAnalysisAdapter(RecordingRetriever([_hit()]), InvalidGenerator(), FixedFallback())

  result = candidate.analyze("Prepare roadmap", _scope())

  assert result.mode == "fallback"
  assert result.fallback_reason == "invalid_citations"
  assert result.citations == []


def test_native_qdrant_store_schema_is_not_the_existing_flat_payload_schema():
  native = QdrantDocumentStore(
    location=":memory:",
    index="native_spike",
    embedding_dim=3,
    recreate_index=True,
    progress_bar=False,
  )
  native.write_documents(
    [
      Document(
        id="chunk-native",
        content="Roadmap",
        embedding=[1.0, 0.0, 0.0],
        meta={"tenant_id": "tenant-a", "acl_subjects": ["tenant:tenant-a"]},
      )
    ]
  )
  native_payload = native._client.scroll(
    collection_name="native_spike",
    with_payload=True,
    with_vectors=False,
  )[0][0].payload

  class RecordingClient:
    def upsert(self, **kwargs):
      self.points = kwargs["points"]

  client = RecordingClient()
  direct = QdrantIngestionAdapter(client, collection_name="direct_spike")
  direct.upsert(
    [
      ChunkRecord(
        chunk_id="chunk-direct",
        document_id="document-1",
        tenant_id="tenant-a",
        project_id="alpha",
        owner_id="user-a",
        source_type="project_context",
        source_uri="eisenhower://project/alpha/context",
        title="Project alpha",
        text="Roadmap",
        position=0,
        checksum="checksum",
        content_version="v1",
        embedding_version="minilm-v1",
        acl_subjects=["tenant:tenant-a"],
      )
    ],
    [[1.0, 0.0, 0.0]],
  )
  direct_payload = client.points[0].payload

  assert native_payload["meta"]["tenant_id"] == "tenant-a"
  assert "tenant_id" not in native_payload
  assert direct_payload["tenant_id"] == "tenant-a"
  assert direct_payload["embedding_version"] == "minilm-v1"
