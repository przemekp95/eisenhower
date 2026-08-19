from collections import UserDict

from fastapi.testclient import TestClient

from app.response_runtime import (
  _chat_input_ids,
  _messages_with_schema,
  _schema_retry_messages,
  _strict_json_content,
  create_response_app,
)


class FakeGenerator:
  def complete(self, *, messages, response_schema, max_tokens, temperature, top_p, seed):
    assert messages == [{"role": "user", "content": "Answer from context"}]
    assert response_schema == {"type": "object"}
    assert (max_tokens, temperature, top_p, seed) == (64, 0.0, 1.0, 7)
    return '{"status":"insufficient_evidence"}', 12, 8


class FakeReranker:
  def score(self, text_1, text_2, *, max_tokens):
    assert text_1 == "query"
    assert text_2 == ["first", "second"]
    assert max_tokens == 192
    return [0.25, 0.75]


def _headers():
  return {"Authorization": "Bearer private-runtime-key"}


def test_schema_constraint_is_the_first_system_instruction_or_merged_into_it():
  schema = {"type": "object", "required": ["status"]}

  without_system = _messages_with_schema(
    [{"role": "user", "content": "Use the evidence"}], schema,
  )
  with_system = _messages_with_schema([
    {"role": "system", "content": "Never invent sources."},
    {"role": "user", "content": "Use the evidence"},
  ], schema)

  assert without_system[0]["role"] == "system"
  assert without_system[1]["role"] == "user"
  assert with_system[0]["content"].startswith("Never invent sources.\n")
  assert "Return only one JSON object" in with_system[0]["content"]
  assert [message["role"] for message in with_system] == ["system", "user"]


def test_chat_template_extracts_input_ids_from_transformers_batch_encoding():
  expected = object()

  class FakeTokenizer:
    def apply_chat_template(self, messages, **options):
      assert messages == [{"role": "user", "content": "bounded"}]
      assert options == {
        "tokenize": True, "add_generation_prompt": True, "return_tensors": "pt",
      }
      return UserDict({"input_ids": expected, "attention_mask": object()})

  assert _chat_input_ids(
    FakeTokenizer(), [{"role": "user", "content": "bounded"}],
  ) is expected


def test_strict_json_content_removes_unrequested_fields_without_inventing_required_data():
  schema = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
      "status": {"enum": ["answered", "insufficient_evidence"]},
    },
    "required": ["status"],
  }

  assert _strict_json_content(
    '{"status":"answered","citation_id":"outside-this-schema"}', schema,
  ) == '{"status":"answered"}'


def test_schema_retry_keeps_correction_in_the_leading_system_message():
  corrected = _schema_retry_messages([
    {"role": "system", "content": "Original constraints"},
    {"role": "user", "content": "Question"},
  ])

  assert [message["role"] for message in corrected] == ["system", "user"]
  assert corrected[0]["content"].startswith("Original constraints\n")
  assert "previous output was invalid" in corrected[0]["content"]
  assert "every required property" in corrected[0]["content"]


def test_response_runtime_requires_bearer_and_exposes_the_exact_model_identity():
  app = create_response_app(
    engine=FakeGenerator(), api_key="private-runtime-key",
    model_id="Qwen/Qwen3-4B-Instruct-2507", max_model_len=8192, runner="generation",
  )
  client = TestClient(app)

  assert client.get("/v1/models").status_code == 401
  response = client.get("/v1/models", headers=_headers())

  assert response.status_code == 200
  assert response.json() == {"data": [{
    "id": "Qwen/Qwen3-4B-Instruct-2507", "max_model_len": 8192,
  }]}


def test_generation_runtime_preserves_the_openai_json_schema_contract_and_limits():
  app = create_response_app(
    engine=FakeGenerator(), api_key="private-runtime-key",
    model_id="Qwen/Qwen3-4B-Instruct-2507", max_model_len=8192, runner="generation",
  )
  response = TestClient(app).post("/v1/chat/completions", headers=_headers(), json={
    "model": "Qwen/Qwen3-4B-Instruct-2507",
    "messages": [{"role": "user", "content": "Answer from context"}],
    "temperature": 0.0,
    "top_p": 1.0,
    "max_tokens": 64,
    "seed": 7,
    "response_format": {
      "type": "json_schema",
      "json_schema": {"name": "answer", "strict": True, "schema": {"type": "object"}},
    },
  })

  assert response.status_code == 200
  assert response.json()["choices"][0]["message"]["content"] == (
    '{"status":"insufficient_evidence"}'
  )
  assert response.json()["usage"] == {
    "prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20,
  }


def test_reranker_runtime_keeps_the_bounded_vllm_score_contract():
  model_id = (
    "BAAI/bge-reranker-v2-m3@953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"
  )
  app = create_response_app(
    engine=FakeReranker(), api_key="private-runtime-key",
    model_id=model_id, max_model_len=192, runner="reranker",
  )
  client = TestClient(app)

  response = client.post("/v1/score", headers=_headers(), json={
    "model": model_id,
    "text_1": "query",
    "text_2": ["first", "second"],
    "truncate_prompt_tokens": 192,
  })

  assert response.status_code == 200
  assert response.json() == {"data": [
    {"index": 0, "score": 0.25}, {"index": 1, "score": 0.75},
  ]}
  too_many = client.post("/v1/score", headers=_headers(), json={
    "model": model_id, "text_1": "query", "text_2": ["x"] * 21,
    "truncate_prompt_tokens": 192,
  })
  assert too_many.status_code == 422
