from __future__ import annotations

from copy import deepcopy
from ipaddress import ip_address
from threading import Lock
from time import monotonic
from urllib.parse import urlparse

import httpx

from ..generation.models import (
  ClassificationOutput,
  GenerationResult,
  KnowledgeAnswerDecision,
  KnowledgeAnswerClaim,
  KnowledgeAnswerOutput,
  KnowledgeAnswerResult,
  KnowledgeGroundedAnswer,
)
from ..generation.registry import PromptRegistry
from ..generation.renderer import PromptRenderer
from .errors import (
  GenerationProviderError,
  GenerationProviderUnavailable,
  InvalidGenerationOutput,
)
from .models import (
  GenerationRequest,
  KnowledgeAnswerRequest,
  RetrievalHit,
)
from .ports import EmbeddingProvider


class MiniLMEmbeddingProvider:
  def __init__(self, local_model, *, version: str):
    self.local_model = local_model
    self._version = version

  @property
  def version(self) -> str:
    return self._version

  def embed(self, texts: list[str]) -> list[list[float]]:
    return [[float(value) for value in self.local_model.encode_text(text)] for text in texts]


class SentenceTransformerEmbeddingProvider:
  def __init__(
    self,
    model_name: str,
    *,
    revision: str,
    version: str,
    device: str | None = None,
    model_factory=None,
  ):
    if not model_name or not revision or not version:
      raise ValueError("embedding model, revision and version are required")
    if model_factory is None:
      from sentence_transformers import SentenceTransformer

      model_factory = SentenceTransformer
    self.model = model_factory(model_name, revision=revision, device=device)
    self._version = version

  @property
  def version(self) -> str:
    return self._version

  def embed(self, texts: list[str]) -> list[list[float]]:
    encoded = self.model.encode(
      texts,
      normalize_embeddings=True,
      convert_to_numpy=True,
      show_progress_bar=False,
    )
    rows = encoded.tolist() if hasattr(encoded, "tolist") else encoded
    return [[float(value) for value in row] for row in rows]


def is_private_service_url(base_url: str, *, allowed_hosts: tuple[str, ...] = ()) -> bool:
  parsed = urlparse(base_url)
  if parsed.scheme not in {"http", "https"} or not parsed.hostname:
    return False
  if any(("@" in parsed.netloc, bool(parsed.query), bool(parsed.fragment))):
    return False
  hostname = parsed.hostname.lower()
  normalized_allowed = {host.strip().lower().rstrip(".") for host in allowed_hosts if host.strip()}
  if hostname.rstrip(".") in normalized_allowed:
    return True
  if hostname in {"localhost", "127.0.0.1", "::1"}:
    return True
  try:
    return ip_address(hostname).is_private
  except ValueError:
    return "." not in hostname or hostname.endswith((".internal", ".local"))


def _classification_contract_schema(base_schema: dict, *, require_grounding: bool) -> dict:
  definitions = base_schema.pop("$defs", {})
  classified = []
  for urgent, important, quadrant in (
    (True, True, 0),
    (True, False, 1),
    (False, True, 2),
    (False, False, 3),
  ):
    branch = deepcopy(base_schema)
    branch["properties"]["status"] = {"const": "classified"}
    branch["properties"]["urgent"] = {"const": urgent}
    branch["properties"]["important"] = {"const": important}
    branch["properties"]["quadrant"] = {"const": quadrant}
    branch["properties"]["confidence"] = {
      "maximum": 1.0,
      "minimum": 0.0,
      "type": "number",
    }
    branch["properties"]["no_answer_reason"] = {"type": "null"}
    if require_grounding:
      branch["properties"]["citations"]["minItems"] = 1
      branch["properties"]["evidence"]["minItems"] = 1
    classified.append(branch)

  abstention = deepcopy(base_schema)
  abstention["properties"]["status"] = {"const": "insufficient_evidence"}
  for field in ("urgent", "important", "quadrant", "confidence"):
    abstention["properties"][field] = {"type": "null"}
  abstention["properties"]["no_answer_reason"] = {"minLength": 1, "type": "string"}
  abstention["properties"]["citations"]["maxItems"] = 0
  abstention["properties"]["evidence"]["maxItems"] = 0
  return {"$defs": definitions, "oneOf": [*classified, abstention]}


def _knowledge_answer_contract_schema(base_schema: dict, *, require_grounding: bool) -> dict:
  definitions = base_schema.pop("$defs", {})
  answered = deepcopy(base_schema)
  answered["properties"]["status"] = {"const": "answered"}
  answered["properties"]["answer"] = {"minLength": 1, "type": "string"}
  answered["properties"]["no_answer_reason"] = {"const": "none"}
  if require_grounding:
    answered["properties"]["claims"]["minItems"] = 1
    answered["properties"]["citations"]["minItems"] = 1

  abstention = deepcopy(base_schema)
  abstention["properties"]["status"] = {"const": "insufficient_evidence"}
  abstention["properties"]["answer"] = {"type": "null"}
  abstention["properties"]["claims"]["maxItems"] = 0
  abstention["properties"]["citations"]["maxItems"] = 0
  abstention["properties"]["no_answer_reason"] = {
    "enum": [
      "insufficient_context",
      "conflicting_context",
      "unsupported_query",
      "prompt_injection_detected",
    ],
    "type": "string",
  }
  return {"$defs": definitions, "oneOf": [answered, abstention]}


class OpenAICompatibleGenerationProvider:
  def __init__(
    self,
    *,
    base_url: str,
    api_key: str,
    prompt_registry: PromptRegistry,
    prompt_renderer: PromptRenderer,
    prompt_id: str,
    prompt_version: str,
    knowledge_prompt_id: str = "knowledge-answer",
    knowledge_prompt_version: str = "1.0.0",
    allowed_hosts: tuple[str, ...] = (),
    connect_timeout_seconds: float = 2.0,
    read_timeout_seconds: float = 15.0,
    write_timeout_seconds: float = 5.0,
    pool_timeout_seconds: float = 1.0,
    client: httpx.Client | None = None,
  ):
    if not is_private_service_url(base_url, allowed_hosts=allowed_hosts):
      raise ValueError("Inference provider must use a fixed private-network endpoint")
    if not api_key:
      raise ValueError("Inference provider service API key is required")
    self.base_url = base_url.rstrip("/")
    self.api_key = api_key
    self.prompt_registry = prompt_registry
    self.prompt_renderer = prompt_renderer
    self.prompt_id = prompt_id
    self.prompt_version = prompt_version
    self.knowledge_prompt_id = knowledge_prompt_id
    self.knowledge_prompt_version = knowledge_prompt_version
    self.client = client or httpx.Client(
      timeout=httpx.Timeout(
        connect=connect_timeout_seconds,
        read=read_timeout_seconds,
        write=write_timeout_seconds,
        pool=pool_timeout_seconds,
      ),
      follow_redirects=False,
    )

  def generate(self, request: GenerationRequest) -> GenerationResult:
    spec = self.prompt_registry.get(self.prompt_id, self.prompt_version, request.language)
    output, rendered = self._complete(request, spec, ClassificationOutput)
    return GenerationResult(
      output=output,
      execution_id=rendered.execution_id,
      prompt_id=spec.prompt_id,
      prompt_version=spec.prompt_version,
      language=spec.language,
      model_id=spec.model_id,
      model_revision=spec.model_revision,
      schema_version=spec.output_schema_version,
      input_tokens=rendered.input_tokens,
      context_chunk_ids=list(rendered.allowed_chunk_ids),
    )

  def answer(self, request: KnowledgeAnswerRequest) -> KnowledgeAnswerResult:
    spec = self.prompt_registry.get(
      self.knowledge_prompt_id,
      self.knowledge_prompt_version,
      request.language,
    )
    decision, rendered = self._complete(request, spec, KnowledgeAnswerDecision)
    if decision.status == "insufficient_evidence":
      output = KnowledgeAnswerOutput(
        status="insufficient_evidence",
        answer=None,
        claims=[],
        citations=[],
        no_answer_reason="insufficient_context",
      )
    else:
      grounded, rendered = self._complete(
        request, spec, KnowledgeGroundedAnswer
      )
      output = KnowledgeAnswerOutput(
        status="answered",
        answer=grounded.answer,
        claims=[KnowledgeAnswerClaim(
          statement=grounded.answer,
          citation_ids=[grounded.citation_id],
        )],
        citations=[grounded.citation_id],
        no_answer_reason="none",
      )
    return KnowledgeAnswerResult(
      output=output,
      execution_id=rendered.execution_id,
      prompt_id=spec.prompt_id,
      prompt_version=spec.prompt_version,
      language=spec.language,
      model_id=spec.model_id,
      model_revision=spec.model_revision,
      schema_version=spec.output_schema_version,
      input_tokens=rendered.input_tokens,
      context_chunk_ids=list(rendered.allowed_chunk_ids),
    )

  def _complete(self, request, spec, output_model):
    rendered = self.prompt_renderer.render(spec, request, output_model=output_model)
    generation = spec.generation_config
    output_schema = deepcopy(output_model.model_json_schema())
    delta_requested = (
      request.known_state is not None
      or request.previous_output_statements is not None
      or request.freshness_requirement == "current_world_required"
    )
    if output_model is ClassificationOutput and not delta_requested:
      output_schema["properties"]["information_delta"] = {"type": "null"}
    allowed_chunk_ids = list(rendered.allowed_chunk_ids)
    if allowed_chunk_ids and output_model in {
      ClassificationOutput,
      KnowledgeAnswerOutput,
      KnowledgeGroundedAnswer,
    }:
      if output_model is KnowledgeGroundedAnswer:
        output_schema["properties"]["citation_id"] = {
          "enum": allowed_chunk_ids,
          "type": "string",
        }
      else:
        output_schema["properties"]["citations"].update({
          "items": {"enum": allowed_chunk_ids, "type": "string"},
        })
      if output_model is ClassificationOutput:
        output_schema["$defs"]["Evidence"]["properties"]["chunk_id"] = {
          "enum": allowed_chunk_ids,
          "type": "string",
        }
      elif output_model is KnowledgeAnswerOutput:
        output_schema["$defs"]["KnowledgeAnswerClaim"]["properties"][
          "citation_ids"
        ]["items"] = {"enum": allowed_chunk_ids, "type": "string"}
    if output_model is ClassificationOutput:
      output_schema = _classification_contract_schema(
        output_schema,
        require_grounding=bool(allowed_chunk_ids),
      )
    elif output_model is KnowledgeAnswerOutput:
      output_schema = _knowledge_answer_contract_schema(
        output_schema,
        require_grounding=bool(allowed_chunk_ids),
      )
    payload = {
      "model": spec.model_id,
      "temperature": generation.temperature,
      "top_p": generation.top_p,
      "n": generation.n,
      "max_tokens": generation.max_tokens,
      "messages": list(rendered.messages),
      "response_format": {
        "type": "json_schema",
        "json_schema": {
          "name": spec.output_schema_id,
          "strict": True,
          "schema": output_schema,
        },
      },
    }
    if generation.seed is not None:
      payload["seed"] = generation.seed
    try:
      response = self.client.post(
        f"{self.base_url}/chat/completions",
        headers={"Authorization": f"Bearer {self.api_key}"},
        json=payload,
      )
      response.raise_for_status()
    except httpx.TimeoutException as error:
      raise GenerationProviderUnavailable(
        "Inference provider request timed out",
        reason="generation_timeout",
      ) from error
    except httpx.RequestError as error:
      raise GenerationProviderUnavailable(
        "Inference provider connection failed",
        reason="generation_connection_error",
      ) from error
    except httpx.HTTPStatusError as error:
      if error.response.status_code == 429:
        raise GenerationProviderUnavailable(
          "Inference provider rate limited the request",
          reason="generation_rate_limited",
        ) from error
      if error.response.status_code >= 500:
        raise GenerationProviderUnavailable(
          "Inference provider returned a server error",
          reason="generation_server_error",
        ) from error
      raise InvalidGenerationOutput("Inference provider rejected the generation contract") from error
    try:
      body = response.json()
      content = body["choices"][0]["message"]["content"]
      output = output_model.model_validate_json(content)
      allowed = set(rendered.allowed_chunk_ids)
      if output_model in {ClassificationOutput, KnowledgeAnswerOutput} and any(
        chunk_id not in allowed for chunk_id in output.citations
      ):
        raise ValueError("Generated citation is outside the rendered context")
      if output_model is ClassificationOutput and any(
        item.chunk_id not in allowed for item in output.evidence
      ):
        raise ValueError("Generated evidence is outside the rendered context")
      if output_model is KnowledgeAnswerOutput and any(
        citation_id not in allowed
        for claim in output.claims
        for citation_id in claim.citation_ids
      ):
        raise ValueError("Generated claim citation is outside the rendered context")
      if (
        output_model is KnowledgeGroundedAnswer
        and output.citation_id not in allowed
      ):
        raise ValueError("Generated answer citation is outside the rendered context")
      return output, rendered
    except (KeyError, IndexError, TypeError, ValueError) as error:
      raise InvalidGenerationOutput("invalid inference provider output") from error

# Compatibility import for existing opt-in live-vLLM checks. Application code uses
# the vendor-neutral name above; vLLM remains one OpenAI-compatible implementation.
VLLMGenerationProvider = OpenAICompatibleGenerationProvider


class CircuitBreakerGenerationProvider:
  def __init__(self, provider, *, failure_threshold: int = 3, reset_seconds: float = 30.0):
    if failure_threshold < 1 or reset_seconds <= 0:
      raise ValueError("Circuit-breaker limits must be positive")
    self.provider = provider
    self.failure_threshold = failure_threshold
    self.reset_seconds = reset_seconds
    self.failures = 0
    self.opened_at: float | None = None
    self._half_open_probe = False
    self._lock = Lock()

  def status(self) -> dict[str, str | int]:
    with self._lock:
      state = "half_open" if self._half_open_probe else "open" if self.opened_at is not None else "closed"
      return {"state": state, "failures": self.failures}

  def generate(self, request: GenerationRequest) -> GenerationResult:
    return self._call("generate", request)

  def answer(self, request: KnowledgeAnswerRequest) -> KnowledgeAnswerResult:
    return self._call("answer", request)

  def _call(self, method: str, request):
    with self._lock:
      if self.opened_at is not None:
        if monotonic() - self.opened_at < self.reset_seconds or self._half_open_probe:
          raise GenerationProviderUnavailable(
            "generation circuit breaker is open",
            reason="generation_circuit_open",
          )
        self._half_open_probe = True
    try:
      result = getattr(self.provider, method)(request)
      with self._lock:
        self.failures = 0
        self.opened_at = None
        self._half_open_probe = False
      return result
    except GenerationProviderError:
      with self._lock:
        self.failures += 1
        if self.failures >= self.failure_threshold or self._half_open_probe:
          self.opened_at = monotonic()
        self._half_open_probe = False
      raise
