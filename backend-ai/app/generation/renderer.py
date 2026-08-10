from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
import re
from typing import Protocol

from .models import ClassificationOutput, PromptSpec


class TokenCounter(Protocol):
  def count_text(self, text: str) -> int: ...

  def count_messages(self, messages: list[dict[str, str]]) -> int: ...


class PromptBudgetError(ValueError):
  pass


class TaskTokenBudgetExceeded(PromptBudgetError):
  pass


@dataclass(frozen=True)
class RenderedPrompt:
  messages: tuple[dict[str, str], ...]
  allowed_chunk_ids: tuple[str, ...]
  input_tokens: int
  execution_id: str


class HuggingFaceTokenCounter:
  def __init__(self, tokenizer):
    self.tokenizer = tokenizer

  @classmethod
  def from_prompt_spec(cls, spec: PromptSpec) -> "HuggingFaceTokenCounter":
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(
      spec.tokenizer_id,
      revision=spec.tokenizer_revision,
      trust_remote_code=False,
    )
    template = tokenizer.chat_template
    if not template:
      raise ValueError("Configured tokenizer does not expose a chat template")
    actual_hash = sha256(template.encode("utf-8")).hexdigest()
    if actual_hash != spec.chat_template_hash:
      raise ValueError("Tokenizer chat template does not match PromptSpec")
    return cls(tokenizer)

  def count_text(self, text: str) -> int:
    return len(self.tokenizer.encode(text, add_special_tokens=False))

  def count_messages(self, messages: list[dict[str, str]]) -> int:
    tokens = self.tokenizer.apply_chat_template(
      messages,
      tokenize=True,
      add_generation_prompt=True,
    )
    return len(tokens)


class PromptRenderer:
  def __init__(self, token_counter: TokenCounter, *, max_chunks_per_document: int = 2):
    if max_chunks_per_document < 1:
      raise ValueError("max_chunks_per_document must be positive")
    self.token_counter = token_counter
    self.max_chunks_per_document = max_chunks_per_document

  def render(self, spec: PromptSpec, request) -> RenderedPrompt:
    if request.language != spec.language:
      raise ValueError("Generation request language does not match PromptSpec")
    task_tokens = self.token_counter.count_text(request.task)
    if task_tokens > spec.task_budget:
      raise TaskTokenBudgetExceeded("Task exceeds the PromptSpec token budget")
    schema_text = json.dumps(
      ClassificationOutput.model_json_schema(),
      ensure_ascii=False,
      sort_keys=True,
      separators=(",", ":"),
    )
    schema_tokens = self.token_counter.count_text(schema_text)
    if self.token_counter.count_text(spec.system_template) + schema_tokens > spec.system_budget:
      raise PromptBudgetError("System template exceeds the PromptSpec token budget")

    selected = self._deduplicate_and_cap(request.context)
    while selected and self._context_tokens(selected) > spec.rag_context_budget:
      selected.pop()

    messages = self._messages(spec, request.task, selected)
    maximum_input = spec.max_model_tokens - spec.output_reserve - spec.safety_reserve
    while selected and (
      self._serialization_tokens(messages, task_tokens, selected) > spec.serialization_budget
      or self.token_counter.count_messages(messages) + schema_tokens > maximum_input
    ):
      selected.pop()
      messages = self._messages(spec, request.task, selected)

    if self._serialization_tokens(messages, task_tokens, selected) > spec.serialization_budget:
      raise PromptBudgetError("Serialization delimiters and identifiers exceed their budget")
    input_tokens = self.token_counter.count_messages(messages) + schema_tokens
    if input_tokens > maximum_input:
      raise PromptBudgetError("Prompt exceeds the total model token budget")

    return RenderedPrompt(
      messages=tuple(messages),
      allowed_chunk_ids=tuple(hit.chunk_id for hit in selected),
      input_tokens=input_tokens,
      execution_id=spec.execution_fingerprint(
        retrieval_version=request.retrieval_version,
        index_version=request.index_version,
      ),
    )

  def _deduplicate_and_cap(self, context):
    selected = []
    seen_chunks: set[str] = set()
    seen_text: set[str] = set()
    per_document: dict[str, int] = {}
    for hit in sorted(context, key=lambda item: (-item.score, item.chunk_id)):
      normalized_text = re.sub(r"\s+", " ", hit.text).strip().casefold()
      if hit.chunk_id in seen_chunks or normalized_text in seen_text:
        continue
      if per_document.get(hit.document_id, 0) >= self.max_chunks_per_document:
        continue
      seen_chunks.add(hit.chunk_id)
      seen_text.add(normalized_text)
      per_document[hit.document_id] = per_document.get(hit.document_id, 0) + 1
      selected.append(hit)
    return selected

  def _context_tokens(self, hits) -> int:
    return sum(self.token_counter.count_text(hit.text) for hit in hits)

  def _serialization_tokens(self, messages, task_tokens: int, hits) -> int:
    user_tokens = self.token_counter.count_text(messages[1]["content"])
    data_tokens = task_tokens + self._context_tokens(hits)
    return max(0, user_tokens - data_tokens)

  @staticmethod
  def _messages(spec: PromptSpec, task: str, hits) -> list[dict[str, str]]:
    task_data = (
      '<task_data untrusted="true">\n'
      f"{json.dumps(task, ensure_ascii=False)}\n"
      "</task_data>"
    )
    documents = []
    for hit in hits:
      documents.append(
        "<document "
        f"chunk_id={json.dumps(hit.chunk_id)} "
        f"document_id={json.dumps(hit.document_id)}>\n"
        f"{json.dumps(hit.text, ensure_ascii=False)}\n"
        "</document>"
      )
    retrieved_context = (
      '<retrieved_context untrusted="true">\n'
      + "\n".join(documents)
      + "\n</retrieved_context>"
    )
    user_content = spec.user_template.format(
      task_data=task_data,
      retrieved_context=retrieved_context,
    )
    return [
      {"role": "system", "content": spec.system_template},
      {"role": "user", "content": user_content},
    ]
