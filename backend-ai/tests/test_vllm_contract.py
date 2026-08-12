"""Opt-in contract tests for the selected live vLLM/model matrix.

These tests are intentionally skipped in generic CPU CI. A controlled GPU job must
provide a PromptSpec whose pinned tokenizer and chat-template checksum match runtime.
"""

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
def test_selected_live_vllm_honors_schema_and_is_repeatable_for_fixed_matrix():
  env = _contract_environment()
  registry = PromptRegistry.load_directory(Path(env["VLLM_CONTRACT_PROMPT_DIR"]))
  spec = registry.get(
    env["VLLM_CONTRACT_PROMPT_ID"],
    env["VLLM_CONTRACT_PROMPT_VERSION"],
    "en",
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
    task="Prepare the important roadmap for next quarter; there is no immediate deadline.",
    language="en",
    retrieval_version="contract-retrieval-v1",
    index_version="contract-index-v1",
    context=[
      RetrievalHit(
        chunk_id="contract-chunk-1",
        document_id="contract-doc-1",
        text="The roadmap affects long-term objectives and has no deadline this week.",
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
  assert len({result.output.model_dump_json() for result in results}) == 1


@pytest.mark.vllm_contract
def test_selected_live_vllm_rejects_known_unsupported_schema_feature():
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

  assert response.status_code == 400
