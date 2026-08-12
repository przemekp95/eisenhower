"""Opt-in contract tests for the selected live vLLM/model matrix.

These tests are intentionally skipped in generic CPU CI. A controlled GPU job must
provide a PromptSpec whose pinned tokenizer and chat-template checksum match runtime.
"""

import json
import os
from pathlib import Path

import httpx
import pytest

from app.generation.registry import PromptRegistry
from app.generation.renderer import HuggingFaceTokenCounter, PromptRenderer
from app.rag.adapters import VLLMGenerationProvider
from app.rag.models import GenerationRequest, RetrievalHit


def _contract_environment():
  required = {
    name: os.environ.get(name)
    for name in (
      "VLLM_CONTRACT_BASE_URL",
      "VLLM_CONTRACT_API_KEY",
      "VLLM_CONTRACT_PROMPT_DIR",
      "VLLM_CONTRACT_PROMPT_ID",
      "VLLM_CONTRACT_PROMPT_VERSION",
      "VLLM_CONTRACT_MODEL",
    )
  }
  missing = [name for name, value in required.items() if not value]
  if missing:
    pytest.skip(f"live vLLM contract environment is missing: {', '.join(missing)}")
  return required


@pytest.mark.vllm_contract
@pytest.mark.parametrize(
  ("language", "task", "context"),
  [
    (
      "en",
      "Prepare the important roadmap for next quarter; there is no immediate deadline.",
      "The roadmap affects long-term objectives and has no deadline this week.",
    ),
    (
      "pl",
      "Przygotuj ważną mapę drogową na kolejny kwartał; nie ma pilnego terminu.",
      "Mapa drogowa wpływa na cele długoterminowe i nie ma terminu w tym tygodniu.",
    ),
  ],
)
def test_selected_live_vllm_honors_schema_and_is_repeatable_for_fixed_matrix(
  language: str,
  task: str,
  context: str,
):
  env = _contract_environment()
  registry = PromptRegistry.load_directory(Path(env["VLLM_CONTRACT_PROMPT_DIR"]))
  spec = registry.get(
    env["VLLM_CONTRACT_PROMPT_ID"],
    env["VLLM_CONTRACT_PROMPT_VERSION"],
    language,
  )
  provider = VLLMGenerationProvider(
    base_url=env["VLLM_CONTRACT_BASE_URL"],
    api_key=env["VLLM_CONTRACT_API_KEY"],
    prompt_registry=registry,
    prompt_renderer=PromptRenderer(HuggingFaceTokenCounter.from_prompt_spec(spec)),
    prompt_id=spec.prompt_id,
    prompt_version=spec.prompt_version,
    read_timeout_seconds=30,
  )
  request = GenerationRequest(
    task=task,
    language=language,
    retrieval_version="contract-retrieval-v1",
    index_version="contract-index-v1",
    context=[
      RetrievalHit(
        chunk_id="contract-chunk-1",
        document_id="contract-doc-1",
        text=context,
        score=1.0,
        source_uri="contract://doc-1",
        title="Roadmap policy",
        tenant_id="contract-tenant",
        embedding_version="contract-embedding-v1",
        content_version="v1",
      )
    ],
  )

  results = [provider.generate(request) for _ in range(3)]

  assert all(result.output.quadrant == 2 for result in results)
  assert len({result.execution_id for result in results}) == 1
  decisions = {
    (
      result.output.status,
      result.output.urgent,
      result.output.important,
      result.output.quadrant,
      tuple(result.output.citations),
      result.output.no_answer_reason,
    )
    for result in results
  }
  assert len(decisions) == 1
  decision = next(iter(decisions))
  assert decision[:4] == ("classified", False, True, 2)
  assert set(decision[4]).issubset({"contract-chunk-1"})
  assert decision[5] is None


@pytest.mark.vllm_contract
def test_selected_live_vllm_requires_auth_and_reports_exact_model_identity():
  env = _contract_environment()
  base_url = env["VLLM_CONTRACT_BASE_URL"].rstrip("/")
  denied = httpx.get(f"{base_url}/models", timeout=10, follow_redirects=False)
  accepted = httpx.get(
    f"{base_url}/models",
    headers={"Authorization": f"Bearer {env['VLLM_CONTRACT_API_KEY']}"},
    timeout=10,
    follow_redirects=False,
  )

  assert denied.status_code == 401
  assert accepted.status_code == 200
  assert [model["id"] for model in accepted.json()["data"]] == [env["VLLM_CONTRACT_MODEL"]]


@pytest.mark.vllm_contract
def test_selected_live_vllm_enforces_strict_json_schema():
  env = _contract_environment()
  response = httpx.post(
    f"{env['VLLM_CONTRACT_BASE_URL'].rstrip('/')}/chat/completions",
    headers={"Authorization": f"Bearer {env['VLLM_CONTRACT_API_KEY']}"},
    json={
      "model": os.environ["VLLM_CONTRACT_MODEL"],
      "messages": [{"role": "user", "content": "Return a value."}],
      "temperature": 0,
      "response_format": {
        "type": "json_schema",
        "json_schema": {
          "name": "unsupported-contract",
          "strict": True,
          "schema": {
            "type": "object",
            "properties": {"value": {"type": "string", "contentMediaType": "text/plain"}},
            "required": ["value"],
            "unevaluatedProperties": False,
          },
        },
      },
    },
    timeout=30,
    follow_redirects=False,
  )

  assert response.status_code == 200
  payload = response.json()
  content = payload["choices"][0]["message"]["content"]
  assert set(json.loads(content)) == {"value"}
