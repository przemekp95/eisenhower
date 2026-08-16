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
  OpenAICompatibleGenerationProvider,
  VLLMGenerationProvider,
)
from app.rag.errors import GenerationProviderUnavailable, InvalidGenerationOutput
from app.rag.models import GenerationRequest, KnowledgeAnswerRequest, RetrievalHit


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
  output_schema = payload["response_format"]["json_schema"]["schema"]
  *classified_schemas, abstention_schema = output_schema["oneOf"]
  assert len(classified_schemas) == 4
  assert {
    (
      schema["properties"]["urgent"]["const"],
      schema["properties"]["important"]["const"],
      schema["properties"]["quadrant"]["const"],
    )
    for schema in classified_schemas
  } == {(True, True, 0), (True, False, 1), (False, True, 2), (False, False, 3)}
  for classified_schema in classified_schemas:
    assert classified_schema["properties"]["information_delta"] == {"type": "null"}
    assert classified_schema["properties"]["status"] == {"const": "classified"}
    assert classified_schema["properties"]["confidence"]["type"] == "number"
    assert classified_schema["properties"]["citations"]["items"]["enum"] == ["chunk-1"]
    assert classified_schema["properties"]["citations"]["minItems"] == 1
    assert classified_schema["properties"]["evidence"]["minItems"] == 1
  assert abstention_schema["properties"]["status"] == {"const": "insufficient_evidence"}
  assert abstention_schema["properties"]["urgent"] == {"type": "null"}
  assert abstention_schema["properties"]["important"] == {"type": "null"}
  assert abstention_schema["properties"]["quadrant"] == {"type": "null"}
  assert abstention_schema["properties"]["confidence"] == {"type": "null"}
  assert abstention_schema["properties"]["citations"]["maxItems"] == 0
  assert abstention_schema["properties"]["evidence"]["maxItems"] == 0
  assert output_schema["$defs"]["Evidence"]["properties"]["chunk_id"]["enum"] == ["chunk-1"]
  assert payload["temperature"] == 0
  assert payload["top_p"] == 1
  assert payload["n"] == 1
  assert payload["seed"] == 17
  assert payload["max_tokens"] == 512
  assert payload["model"] == "approved-model"
  assert "ignore previous instructions" in payload["messages"][0]["content"]


def test_vllm_adapter_uses_separate_strict_knowledge_answer_schema():
  seen = {"payloads": []}

  def handler(request):
    seen["payloads"].append(json.loads(request.content))
    content = (
      {"status": "answered"}
      if len(seen["payloads"]) == 1
      else {
        "status": "answered",
        "answer": "MongoDB is canonical.",
        "citation_id": "chunk-1",
        "no_answer_reason": "none",
      }
    )
    return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(content)}}]})

  answer_spec = _prompt_spec(
    prompt_id="knowledge-answer",
    output_schema_id="knowledge-answer",
    domain_rules_version="grounded-answer-v1",
  )
  provider = VLLMGenerationProvider(
    base_url="http://vllm.internal:8000/v1",
    api_key="test-token",
    prompt_registry=PromptRegistry([answer_spec]),
    prompt_renderer=PromptRenderer(WordCounter()),
    prompt_id="eisenhower-classifier",
    prompt_version="1.0.0",
    knowledge_prompt_id="knowledge-answer",
    knowledge_prompt_version="1.0.0",
    client=httpx.Client(transport=httpx.MockTransport(handler), timeout=3.0),
  )
  hit = RetrievalHit(
    chunk_id="chunk-1",
    document_id="doc",
    text="MongoDB is canonical.",
    score=0.9,
    source_uri="knowledge://architecture",
    title="Architecture",
    tenant_id="tenant-a",
    embedding_version="bge-m3-v1",
    content_version="v1",
  )

  result = provider.answer(KnowledgeAnswerRequest(
    task="Co jest kanoniczne?", context=[hit], language="pl"
  ))

  assert result.output.answer == "MongoDB is canonical."
  decision_schema = seen["payloads"][0]["response_format"]["json_schema"]["schema"]
  answer_schema = seen["payloads"][1]["response_format"]["json_schema"]["schema"]
  assert set(decision_schema["properties"]) == {"status"}
  assert "quadrant" not in answer_schema["properties"]
  assert set(answer_schema["properties"]) == {
    "status", "answer", "citation_id", "no_answer_reason"
  }
  assert answer_schema["properties"]["citation_id"]["enum"] == ["chunk-1"]


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


def test_openai_compatible_adapter_accepts_explicit_remote_private_host_without_vendor_assumptions():
  provider = OpenAICompatibleGenerationProvider(
    base_url="https://gpu.mesh.example/v1",
    allowed_hosts=("gpu.mesh.example",),
    api_key="token",
    prompt_registry=PromptRegistry([_prompt_spec()]),
    prompt_renderer=PromptRenderer(WordCounter()),
    prompt_id="eisenhower-classifier",
    prompt_version="1.0.0",
    client=httpx.Client(transport=httpx.MockTransport(lambda _request: httpx.Response(503))),
  )

  assert provider.base_url == "https://gpu.mesh.example/v1"


@pytest.mark.parametrize(
  "base_url",
  [
    "https://user:password@gpu.internal/v1",
    "https://gpu.internal/v1?target=other",
    "https://gpu.internal/v1#fragment",
    "https://gpu.mesh.example/v1",
  ],
)
def test_openai_compatible_adapter_rejects_ambiguous_or_unapproved_endpoint(base_url):
  with pytest.raises(ValueError, match="private-network endpoint"):
    OpenAICompatibleGenerationProvider(
      base_url=base_url,
      allowed_hosts=(),
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

  with pytest.raises(InvalidGenerationOutput, match="invalid inference provider output"):
    provider.generate(request)


@pytest.mark.parametrize(
  ("failure", "message"),
  [
    (httpx.ReadTimeout("slow"), "Inference provider request timed out"),
    (httpx.ConnectError("offline"), "Inference provider connection failed"),
    (httpx.RemoteProtocolError("connection interrupted"), "Inference provider connection failed"),
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


def test_generation_circuit_breaker_reports_bounded_state_without_exposing_provider_details():
  class Failing:
    def generate(self, _request):
      raise GenerationProviderUnavailable("offline", reason="generation_connection_error")

  protected = CircuitBreakerGenerationProvider(Failing(), failure_threshold=1, reset_seconds=60)

  assert protected.status() == {"state": "closed", "failures": 0}
  with pytest.raises(GenerationProviderUnavailable):
    protected.generate(GenerationRequest(task="task", context=[]))
  assert protected.status() == {"state": "open", "failures": 1}
