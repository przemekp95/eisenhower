from __future__ import annotations

import argparse
from collections.abc import Mapping
from hmac import compare_digest
import json
import os
from typing import Literal, Protocol

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator


MAX_RERANKER_CANDIDATES = 20
MAX_MESSAGE_CHARACTERS = 80_000
MAX_GENERATION_TOKENS = 1_024


class _StrictModel(BaseModel):
  model_config = ConfigDict(extra="forbid")


class Message(_StrictModel):
  role: Literal["system", "user", "assistant"]
  content: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARACTERS)


class JsonSchema(_StrictModel):
  name: str = Field(min_length=1, max_length=128)
  strict: Literal[True]
  schema_: dict = Field(alias="schema")


class ResponseFormat(_StrictModel):
  type: Literal["json_schema"]
  json_schema: JsonSchema


class ChatRequest(_StrictModel):
  model: str = Field(min_length=1, max_length=256)
  messages: list[Message] = Field(min_length=1, max_length=32)
  response_format: ResponseFormat
  temperature: float = Field(ge=0, le=2)
  top_p: float = Field(gt=0, le=1)
  n: Literal[1] = 1
  max_tokens: int = Field(ge=1, le=MAX_GENERATION_TOKENS)
  seed: int | None = None


class ScoreRequest(_StrictModel):
  model: str = Field(min_length=1, max_length=256)
  text_1: str = Field(min_length=1, max_length=2_000)
  text_2: list[str] = Field(min_length=1, max_length=MAX_RERANKER_CANDIDATES)
  truncate_prompt_tokens: int = Field(ge=1, le=192)

  @model_validator(mode="after")
  def validate_candidates(self):
    if any(not item or len(item) > 8_000 for item in self.text_2):
      raise ValueError("reranker candidates must be non-empty and bounded")
    return self


class GenerationEngine(Protocol):
  def complete(
    self, *, messages: list[dict[str, str]], response_schema: dict,
    max_tokens: int, temperature: float, top_p: float, seed: int | None,
  ) -> tuple[str, int, int]: ...


class RerankerEngine(Protocol):
  def score(self, text_1: str, text_2: list[str], *, max_tokens: int) -> list[float]: ...


def create_response_app(
  *, engine: GenerationEngine | RerankerEngine, api_key: str,
  model_id: str, max_model_len: int, runner: Literal["generation", "reranker"],
) -> FastAPI:
  if not api_key:
    raise ValueError("private response runtime requires a Bearer key")
  app = FastAPI(title="Eisenhower private response runtime", docs_url=None, redoc_url=None)

  def authorize(authorization: str | None = Header(default=None)) -> None:
    expected = f"Bearer {api_key}"
    if authorization is None or not compare_digest(authorization, expected):
      raise HTTPException(status_code=401, detail="Authentication required")

  @app.get("/health/ready")
  def ready():
    return {"status": "ready", "runner": runner}

  @app.get("/v1/models", dependencies=[])
  def models(authorization: str | None = Header(default=None)):
    authorize(authorization)
    return {"data": [{"id": model_id, "max_model_len": max_model_len}]}

  @app.post("/v1/chat/completions")
  def chat(request: ChatRequest, authorization: str | None = Header(default=None)):
    authorize(authorization)
    if runner != "generation" or request.model != model_id:
      raise HTTPException(status_code=400, detail="Generation model is unavailable")
    content, prompt_tokens, completion_tokens = engine.complete(
      messages=[message.model_dump() for message in request.messages],
      response_schema=request.response_format.json_schema.schema_,
      max_tokens=request.max_tokens,
      temperature=request.temperature,
      top_p=request.top_p,
      seed=request.seed,
    )
    return {
      "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}],
      "usage": {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
      },
    }

  @app.post("/v1/score")
  def score(request: ScoreRequest, authorization: str | None = Header(default=None)):
    authorize(authorization)
    if runner != "reranker" or request.model != model_id:
      raise HTTPException(status_code=400, detail="Reranker model is unavailable")
    scores = engine.score(
      request.text_1, request.text_2, max_tokens=request.truncate_prompt_tokens,
    )
    if len(scores) != len(request.text_2):
      raise HTTPException(status_code=502, detail="Reranker returned an invalid score count")
    return {"data": [
      {"index": index, "score": float(value)} for index, value in enumerate(scores)
    ]}

  return app


class TransformersGenerator:
  def __init__(self, model: str, revision: str, *, max_model_len: int):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    self.torch = torch
    self.max_model_len = max_model_len
    self.tokenizer = AutoTokenizer.from_pretrained(
      model, revision=revision, local_files_only=True, trust_remote_code=False,
    )
    self.model = AutoModelForCausalLM.from_pretrained(
      model, revision=revision, local_files_only=True, trust_remote_code=False,
      dtype=torch.bfloat16,
    ).to("cuda").eval()

  def complete(
    self, *, messages: list[dict[str, str]], response_schema: dict,
    max_tokens: int, temperature: float, top_p: float, seed: int | None,
  ) -> tuple[str, int, int]:
    constrained = _messages_with_schema(messages, response_schema)
    generate_options = {
      "max_new_tokens": max_tokens,
      "do_sample": temperature > 0,
      "pad_token_id": self.tokenizer.eos_token_id,
    }
    if temperature > 0:
      generate_options.update({"temperature": temperature, "top_p": top_p})
    prompt_tokens = 0
    completion_tokens = 0
    for attempt in range(3):
      inputs = _chat_input_ids(self.tokenizer, constrained).to("cuda")
      if inputs.shape[-1] + max_tokens > self.max_model_len:
        raise ValueError("generation request exceeds the configured context bound")
      if seed is not None:
        self.torch.manual_seed(seed)
        self.torch.cuda.manual_seed_all(seed)
      with self.torch.inference_mode():
        output = self.model.generate(inputs, **generate_options)
      generated = output[0, inputs.shape[-1]:]
      prompt_tokens += int(inputs.shape[-1])
      completion_tokens += int(generated.shape[-1])
      content = self.tokenizer.decode(generated, skip_special_tokens=True).strip()
      try:
        return (
          _strict_json_content(content, response_schema),
          prompt_tokens,
          completion_tokens,
        )
      except ValueError:
        if attempt == 2:
          raise
        constrained = _schema_retry_messages(constrained)
    raise RuntimeError("unreachable generation retry state")


def _messages_with_schema(
  messages: list[dict[str, str]], response_schema: dict,
) -> list[dict[str, str]]:
  schema_instruction = (
    "Return only one JSON object matching this JSON Schema exactly: "
    + json.dumps(response_schema, separators=(",", ":"), sort_keys=True)
  )
  constrained = [dict(message) for message in messages]
  if constrained[0]["role"] == "system":
    constrained[0]["content"] = constrained[0]["content"] + "\n" + schema_instruction
    return constrained
  return [{"role": "system", "content": schema_instruction}, *constrained]


def _schema_retry_messages(messages: list[dict[str, str]]) -> list[dict[str, str]]:
  corrected = [dict(message) for message in messages]
  correction = (
    "The previous output was invalid. Return one JSON object only and include every "
    "required property from the supplied schema. Do not add markdown or commentary."
  )
  corrected[0]["content"] = corrected[0]["content"] + "\n" + correction
  return corrected


def _chat_input_ids(tokenizer, messages: list[dict[str, str]]):
  tokenized = tokenizer.apply_chat_template(
    messages, tokenize=True, add_generation_prompt=True, return_tensors="pt",
  )
  if isinstance(tokenized, Mapping):
    return tokenized["input_ids"]
  return tokenized


def _strict_json_content(content: str, schema: dict) -> str:
  value = json.loads(content)
  projected = _project_json_value(value, schema, schema)
  return json.dumps(projected, ensure_ascii=False, separators=(",", ":"))


def _project_json_value(value, schema: dict, root_schema: dict):
  if "$ref" in schema:
    prefix = "#/$defs/"
    reference = schema["$ref"]
    if not reference.startswith(prefix):
      raise ValueError("only local JSON Schema references are supported")
    schema = root_schema.get("$defs", {}).get(reference[len(prefix):], {})
  if "oneOf" in schema:
    matching = [
      branch for branch in schema["oneOf"]
      if _schema_discriminator_matches(value, branch)
    ]
    if len(matching) != 1:
      raise ValueError("generated JSON does not select one schema branch")
    schema = matching[0]
  if isinstance(value, dict):
    required = set(schema.get("required", []))
    if not required.issubset(value):
      raise ValueError("generated JSON is missing required fields")
    properties = schema.get("properties", {})
    if schema.get("additionalProperties") is False:
      value = {key: item for key, item in value.items() if key in properties}
    return {
      key: _project_json_value(item, properties.get(key, {}), root_schema)
      for key, item in value.items()
    }
  if isinstance(value, list) and isinstance(schema.get("items"), dict):
    return [_project_json_value(item, schema["items"], root_schema) for item in value]
  if "const" in schema and value != schema["const"]:
    raise ValueError("generated JSON violates a constant schema value")
  if "enum" in schema and value not in schema["enum"]:
    raise ValueError("generated JSON violates an enumerated schema value")
  return value


def _schema_discriminator_matches(value, schema: dict) -> bool:
  if not isinstance(value, dict):
    return True
  for key, property_schema in schema.get("properties", {}).items():
    if key not in value:
      continue
    if "const" in property_schema and value[key] != property_schema["const"]:
      return False
    if "enum" in property_schema and value[key] not in property_schema["enum"]:
      return False
  return True


class TransformersReranker:
  def __init__(self, model: str, revision: str):
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    self.torch = torch
    self.tokenizer = AutoTokenizer.from_pretrained(
      model, revision=revision, local_files_only=True, trust_remote_code=False,
    )
    self.model = AutoModelForSequenceClassification.from_pretrained(
      model, revision=revision, local_files_only=True, trust_remote_code=False,
      dtype=torch.float16,
    ).to("cuda").eval()

  def score(self, text_1: str, text_2: list[str], *, max_tokens: int) -> list[float]:
    encoded = self.tokenizer(
      [[text_1, candidate] for candidate in text_2], padding=True, truncation=True,
      max_length=max_tokens, return_tensors="pt",
    ).to("cuda")
    with self.torch.inference_mode():
      logits = self.model(**encoded).logits.reshape(-1).float()
    return self.torch.sigmoid(logits).cpu().tolist()


def _arguments() -> argparse.Namespace:
  parser = argparse.ArgumentParser()
  parser.add_argument("--model", required=True)
  parser.add_argument("--revision", required=True)
  parser.add_argument("--tokenizer")
  parser.add_argument("--tokenizer-revision")
  parser.add_argument("--served-model-name", required=True)
  parser.add_argument("--api-key")
  parser.add_argument("--dtype")
  parser.add_argument("--max-model-len", type=int, required=True)
  parser.add_argument("--max-num-seqs")
  parser.add_argument("--gpu-memory-utilization")
  parser.add_argument("--runner", choices=("generation", "pooling"), default="generation")
  parser.add_argument("--disable-log-requests", action="store_true")
  parser.add_argument("--no-enable-log-requests", action="store_true")
  return parser.parse_args()


def main() -> None:
  import uvicorn

  args = _arguments()
  runner = "reranker" if args.runner == "pooling" else "generation"
  engine = (
    TransformersReranker(args.model, args.revision)
    if runner == "reranker"
    else TransformersGenerator(args.model, args.revision, max_model_len=args.max_model_len)
  )
  app = create_response_app(
    engine=engine,
    api_key=args.api_key or os.environ.get("VLLM_API_KEY", ""),
    model_id=args.served_model_name,
    max_model_len=args.max_model_len,
    runner=runner,
  )
  uvicorn.run(app, host="0.0.0.0", port=8000, workers=1, access_log=False)


if __name__ == "__main__":
  main()
