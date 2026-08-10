import json

import httpx
import pytest

from test_generation_contract import _prompt_spec
from test_prompt_renderer import WordCounter

from app.generation.models import ClassificationOutput
from app.generation.registry import PromptRegistry
from app.generation.renderer import PromptRenderer
from app.rag.adapters import (
  CircuitBreakerGenerationProvider,
  QdrantIngestionAdapter,
  QdrantRetriever,
  VLLMGenerationProvider,
)
from app.rag.errors import GenerationProviderUnavailable, InvalidGenerationOutput
from app.rag.models import (
  AccessScope,
  ChunkRecord,
  GenerationRequest,
  RetrievalHit,
  RetrievalQuery,
  SourceDocument,
)


class StubEmbedding:
  version = "minilm-v1"

  def embed(self, texts):
    assert texts == ["roadmap"]
    return [[0.1, 0.2, 0.3]]


class StubQdrant:
  def __init__(self):
    self.query = None

  def query_points(self, **kwargs):
    self.query = kwargs
    point = type(
      "Point",
      (),
      {
        "id": "chunk-1",
        "score": 0.91,
        "payload": {
          "chunk_id": "chunk-1",
          "document_id": "doc-1",
          "text": "context",
          "source_uri": "task://1",
          "title": "Task",
          "tenant_id": "tenant-a",
          "project_id": "project-1",
          "embedding_version": "minilm-v1",
          "content_version": "v1",
          "acl_subjects": ["user:user-1"],
          "deleted": False,
        },
      },
    )()
    return type("Result", (), {"points": [point]})()


def test_qdrant_retriever_always_builds_tenant_acl_version_and_tombstone_filters():
  client = StubQdrant()
  retriever = QdrantRetriever(client, StubEmbedding(), collection_alias="knowledge-active")

  hits = retriever.retrieve(
    RetrievalQuery(
      text="roadmap",
      project_id="project-1",
      scope=AccessScope(
        tenant_id="tenant-a",
        user_id="user-1",
        project_ids=["project-1"],
      ),
    )
  )

  assert hits[0].tenant_id == "tenant-a"
  serialized_filter = repr(client.query["query_filter"])
  assert "tenant-a" in serialized_filter
  assert "user:user-1" in serialized_filter
  assert "minilm-v1" in serialized_filter
  assert "deleted" in serialized_filter
  assert "key='project_id'" in serialized_filter


def test_vllm_adapter_uses_private_fixed_base_url_api_key_timeout_and_json_schema():
  seen = {}

  def handler(request):
    seen["request"] = request
    return httpx.Response(
      200,
      json={
        "choices": [
          {
            "message": {
              "content": json.dumps(
                {
                  "status": "classified",
                  "urgent": False,
                  "important": True,
                  "quadrant": 2,
                  "facts": [{"statement": "The task is a roadmap.", "source": "task"}],
                  "evidence": [
                    {
                      "statement": "The roadmap affects long-term goals.",
                      "source": "retrieved_context",
                      "chunk_id": "chunk-1",
                    }
                  ],
                  "citations": ["chunk-1"],
                  "confidence": 0.8,
                  "explanation": "Important, not urgent.",
                  "no_answer_reason": None,
                }
              )
            }
          }
        ]
      },
    )

  client = httpx.Client(transport=httpx.MockTransport(handler), timeout=3.0)
  provider = VLLMGenerationProvider(
    base_url="http://vllm.internal:8000/v1",
    api_key="test-token",
    prompt_registry=PromptRegistry([_prompt_spec(model_id="approved-model")]),
    prompt_renderer=PromptRenderer(WordCounter()),
    prompt_id="eisenhower-classifier",
    prompt_version="1.0.0",
    client=client,
  )
  hit = RetrievalHit(
    chunk_id="chunk-1",
    document_id="doc",
    text="Known context",
    score=0.8,
    source_uri="task://1",
    title="Task",
    tenant_id="tenant-a",
    embedding_version="minilm-v1",
    content_version="v1",
  )

  result = provider.generate(
    GenerationRequest(
      task="roadmap",
      context=[hit],
      language="pl",
      retrieval_version="retrieval-v1",
      index_version="index-v1",
    )
  )

  assert result.output.citations == ["chunk-1"]
  assert result.prompt_version == "1.0.0"
  assert result.context_chunk_ids == ["chunk-1"]
  assert seen["request"].url.host == "vllm.internal"
  assert seen["request"].headers["authorization"] == "Bearer test-token"
  payload = json.loads(seen["request"].content)
  assert payload["response_format"]["type"] == "json_schema"
  assert payload["response_format"]["json_schema"]["schema"] == ClassificationOutput.model_json_schema()
  assert payload["temperature"] == 0
  assert payload["top_p"] == 1
  assert payload["n"] == 1
  assert payload["seed"] == 17
  assert payload["max_tokens"] == 512
  assert payload["model"] == "approved-model"
  assert "ignore previous instructions" in payload["messages"][0]["content"]


def test_vllm_adapter_rejects_public_or_mutable_endpoints():
  with pytest.raises(ValueError):
    VLLMGenerationProvider(
      base_url="https://api.example.com/v1",
      api_key="token",
      prompt_registry=PromptRegistry([_prompt_spec()]),
      prompt_renderer=PromptRenderer(WordCounter()),
      prompt_id="eisenhower-classifier",
      prompt_version="1.0.0",
    )


@pytest.mark.parametrize(
  "content",
  [
    "",
    "{",
    json.dumps(
      {
        "status": "classified",
        "urgent": True,
        "important": False,
        "quadrant": 2,
        "facts": [],
        "evidence": [],
        "citations": [],
        "explanation": "Wrong mapping.",
        "confidence": 0.5,
        "no_answer_reason": None,
      }
    ),
    json.dumps(
      {
        "status": "classified",
        "urgent": False,
        "important": True,
        "quadrant": 2,
        "facts": [],
        "evidence": [],
        "citations": ["invented"],
        "explanation": "Invented citation.",
        "confidence": 0.5,
        "no_answer_reason": None,
      }
    ),
  ],
)
def test_vllm_adapter_rejects_empty_truncated_semantically_invalid_or_foreign_output(content):
  def handler(_request):
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

  provider = VLLMGenerationProvider(
    base_url="http://vllm.internal:8000/v1",
    api_key="token",
    prompt_registry=PromptRegistry([_prompt_spec()]),
    prompt_renderer=PromptRenderer(WordCounter()),
    prompt_id="eisenhower-classifier",
    prompt_version="1.0.0",
    client=httpx.Client(transport=httpx.MockTransport(handler)),
  )
  request = GenerationRequest(
    task="roadmap",
    context=[
      RetrievalHit(
        chunk_id="chunk-1",
        document_id="doc",
        text="Known context",
        score=0.8,
        source_uri="task://1",
        title="Task",
        tenant_id="tenant-a",
        embedding_version="minilm-v1",
        content_version="v1",
      )
    ],
    language="pl",
  )

  with pytest.raises(InvalidGenerationOutput, match="invalid vLLM output"):
    provider.generate(request)


@pytest.mark.parametrize(
  ("failure", "message"),
  [
    (httpx.ReadTimeout("slow"), "vLLM request timed out"),
    (httpx.ConnectError("offline"), "vLLM request failed"),
  ],
)
def test_vllm_adapter_maps_transport_failures_to_typed_unavailable_error(failure, message):
  def handler(request):
    raise failure

  provider = VLLMGenerationProvider(
    base_url="http://vllm.internal:8000/v1",
    api_key="token",
    prompt_registry=PromptRegistry([_prompt_spec()]),
    prompt_renderer=PromptRenderer(WordCounter()),
    prompt_id="eisenhower-classifier",
    prompt_version="1.0.0",
    client=httpx.Client(transport=httpx.MockTransport(handler)),
  )

  with pytest.raises(GenerationProviderUnavailable, match=message):
    provider.generate(GenerationRequest(task="roadmap", context=[], language="pl"))


@pytest.mark.parametrize(
  ("status_code", "error_type"),
  [(400, InvalidGenerationOutput), (429, GenerationProviderUnavailable), (503, GenerationProviderUnavailable)],
)
def test_vllm_adapter_maps_http_status_by_retry_semantics(status_code, error_type):
  provider = VLLMGenerationProvider(
    base_url="http://vllm.internal:8000/v1",
    api_key="token",
    prompt_registry=PromptRegistry([_prompt_spec()]),
    prompt_renderer=PromptRenderer(WordCounter()),
    prompt_id="eisenhower-classifier",
    prompt_version="1.0.0",
    client=httpx.Client(
      transport=httpx.MockTransport(lambda _request: httpx.Response(status_code))
    ),
  )

  with pytest.raises(error_type):
    provider.generate(GenerationRequest(task="roadmap", context=[], language="pl"))


def test_qdrant_ingestion_replaces_stale_document_before_upserting_current_version():
  class Client:
    def __init__(self):
      self.upsert_call = None
      self.payload_calls = []
      self.call_order = []

    def upsert(self, **kwargs):
      self.call_order.append("upsert")
      self.upsert_call = kwargs

    def set_payload(self, **kwargs):
      self.call_order.append("set_payload")
      self.payload_calls.append(kwargs)

  client = Client()
  adapter = QdrantIngestionAdapter(client, collection_name="knowledge-v1")
  document = SourceDocument(
    document_id="doc-1",
    tenant_id="tenant-a",
    project_id="project-1",
    owner_id="user-1",
    source_type="task",
    source_uri="task://1",
    title="Task",
    text="Context",
    content_version="v2",
    acl_subjects=["user:user-1"],
  )
  chunk = ChunkRecord(
    chunk_id="a" * 64,
    document_id="doc-1",
    tenant_id="tenant-a",
    project_id="project-1",
    owner_id="user-1",
    source_type="task",
    source_uri="task://1",
    title="Task",
    text="Context",
    position=0,
    checksum="b" * 64,
    content_version="v2",
    embedding_version="minilm-v1",
    acl_subjects=["user:user-1"],
  )

  adapter.replace_documents([document], [chunk], [[0.1, 0.2, 0.3]])

  point = client.upsert_call["points"][0]
  assert client.call_order == ["set_payload", "upsert"]
  assert point.payload["tenant_id"] == "tenant-a"
  assert point.payload["acl_subjects"] == ["user:user-1"]
  assert point.payload["embedding_version"] == "minilm-v1"
  assert point.payload["content_version"] == "v2"
  assert client.payload_calls[0]["payload"] == {"deleted": True}
  assert "tenant-a" in repr(client.payload_calls[0]["points"])
  assert "doc-1" in repr(client.payload_calls[0]["points"])


def test_generation_circuit_breaker_opens_after_bounded_failures():
  class Failing:
    def __init__(self):
      self.calls = 0

    def generate(self, _request):
      self.calls += 1
      raise GenerationProviderUnavailable("offline")

  failing = Failing()
  protected = CircuitBreakerGenerationProvider(failing, failure_threshold=2, reset_seconds=60)
  request = GenerationRequest(task="task", context=[])

  with pytest.raises(GenerationProviderUnavailable):
    protected.generate(request)
  with pytest.raises(GenerationProviderUnavailable):
    protected.generate(request)
  with pytest.raises(GenerationProviderUnavailable, match="circuit breaker is open"):
    protected.generate(request)

  assert failing.calls == 2


def test_generation_circuit_breaker_does_not_count_unexpected_programming_errors():
  class Broken:
    def generate(self, _request):
      raise ValueError("bad implementation")

  protected = CircuitBreakerGenerationProvider(Broken(), failure_threshold=1, reset_seconds=60)

  with pytest.raises(ValueError, match="bad implementation"):
    protected.generate(GenerationRequest(task="task", context=[]))

  assert protected.failures == 0
  assert protected.opened_at is None


def test_generation_circuit_breaker_counts_invalid_provider_output():
  class Invalid:
    def generate(self, _request):
      raise InvalidGenerationOutput("bad schema")

  protected = CircuitBreakerGenerationProvider(Invalid(), failure_threshold=1, reset_seconds=60)
  request = GenerationRequest(task="task", context=[])

  with pytest.raises(InvalidGenerationOutput):
    protected.generate(request)
  with pytest.raises(GenerationProviderUnavailable, match="circuit breaker is open"):
    protected.generate(request)
