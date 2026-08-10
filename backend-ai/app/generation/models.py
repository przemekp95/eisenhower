from __future__ import annotations

from datetime import datetime
from hashlib import sha256
import json
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


SEMVER_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
CHECKSUM_PATTERN = re.compile(r"^[a-f0-9]{64}$")
CONTEXT_POOL_LIMIT = 4800


class StrictFrozenModel(BaseModel):
  model_config = ConfigDict(extra="forbid", frozen=True)


class GenerationConfig(StrictFrozenModel):
  temperature: float = 0.0
  top_p: float = 1.0
  n: int = 1
  seed: int | None = None
  max_tokens: int = Field(..., ge=1)

  @model_validator(mode="after")
  def deterministic_settings_are_explicit(self):
    if self.temperature != 0 or self.top_p != 1 or self.n != 1:
      raise ValueError("generation config must use temperature=0, top_p=1 and n=1")
    return self


class PromptSpec(StrictFrozenModel):
  prompt_id: str = Field(..., min_length=1, max_length=128)
  prompt_version: str
  status: Literal["draft", "candidate", "canary", "champion", "retired"]
  language: Literal["pl", "en"]
  system_template: str = Field(..., min_length=1)
  user_template: str = Field(..., min_length=1)
  domain_rules_version: str = Field(..., min_length=1, max_length=128)
  tie_break_rules_version: str = Field(..., min_length=1, max_length=128)
  model_id: str = Field(..., min_length=1, max_length=256)
  model_revision: str = Field(..., min_length=1, max_length=256)
  tokenizer_id: str = Field(..., min_length=1, max_length=256)
  tokenizer_revision: str = Field(..., min_length=1, max_length=256)
  chat_template_hash: str
  output_schema_id: str = Field(..., min_length=1, max_length=128)
  output_schema_version: str
  max_model_tokens: int = Field(..., ge=1)
  system_budget: int = Field(..., ge=1)
  task_budget: int = Field(..., ge=1)
  rag_context_budget: int = Field(..., ge=0)
  memory_context_budget: int = Field(..., ge=0)
  serialization_budget: int = Field(..., ge=1)
  output_reserve: int = Field(..., ge=1)
  safety_reserve: int = Field(..., ge=1)
  generation_config: GenerationConfig
  changelog: str = Field(..., min_length=1, max_length=2000)
  created_at: datetime
  artifact_checksum: str

  @classmethod
  def create(cls, **values) -> "PromptSpec":
    candidate = cls(artifact_checksum="0" * 64, **values)
    return candidate.model_copy(update={"artifact_checksum": candidate.compute_checksum()})

  @model_validator(mode="after")
  def validate_contract(self):
    if not SEMVER_PATTERN.fullmatch(self.prompt_version):
      raise ValueError("prompt_version must use MAJOR.MINOR.PATCH")
    if not SEMVER_PATTERN.fullmatch(self.output_schema_version):
      raise ValueError("output_schema_version must use MAJOR.MINOR.PATCH")
    if not CHECKSUM_PATTERN.fullmatch(self.chat_template_hash):
      raise ValueError("chat_template_hash must be a lowercase SHA-256")
    if not CHECKSUM_PATTERN.fullmatch(self.artifact_checksum):
      raise ValueError("artifact_checksum must be a lowercase SHA-256")
    if "{task_data}" not in self.user_template or "{retrieved_context}" not in self.user_template:
      raise ValueError("user_template must require task_data and retrieved_context")
    if self.rag_context_budget + self.memory_context_budget > CONTEXT_POOL_LIMIT:
      raise ValueError("RAG and memory must fit the shared 4800-token pool")
    reserved = (
      self.system_budget
      + self.task_budget
      + self.rag_context_budget
      + self.memory_context_budget
      + self.serialization_budget
      + self.output_reserve
      + self.safety_reserve
    )
    if reserved > self.max_model_tokens:
      raise ValueError("reserved token budgets exceed max_model_tokens")
    if self.generation_config.max_tokens > self.output_reserve:
      raise ValueError("generation max_tokens must fit output_reserve")
    return self

  def canonical_payload(self) -> dict:
    return self.model_dump(mode="json", exclude={"artifact_checksum"})

  def compute_checksum(self) -> str:
    encoded = json.dumps(
      self.canonical_payload(), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return sha256(encoded).hexdigest()

  def verify_checksum(self) -> bool:
    return self.artifact_checksum == self.compute_checksum()

  def execution_fingerprint(self, *, retrieval_version: str, index_version: str) -> str:
    matrix = {
      "prompt_id": self.prompt_id,
      "prompt_version": self.prompt_version,
      "language": self.language,
      "domain_rules_version": self.domain_rules_version,
      "tie_break_rules_version": self.tie_break_rules_version,
      "output_schema_id": self.output_schema_id,
      "output_schema_version": self.output_schema_version,
      "model_id": self.model_id,
      "model_revision": self.model_revision,
      "tokenizer_id": self.tokenizer_id,
      "tokenizer_revision": self.tokenizer_revision,
      "chat_template_hash": self.chat_template_hash,
      "retrieval_version": retrieval_version,
      "index_version": index_version,
    }
    encoded = json.dumps(matrix, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256(encoded).hexdigest()


class Fact(StrictFrozenModel):
  statement: str = Field(..., min_length=1, max_length=500)
  source: Literal["task"]


class Evidence(StrictFrozenModel):
  statement: str = Field(..., min_length=1, max_length=500)
  source: Literal["retrieved_context"]
  chunk_id: str = Field(..., min_length=1, max_length=256)


class ClassificationOutput(StrictFrozenModel):
  status: Literal["classified", "insufficient_evidence"]
  urgent: bool | None
  important: bool | None
  quadrant: int | None = Field(..., ge=0, le=3)
  facts: list[Fact] = Field(default_factory=list, max_length=12)
  evidence: list[Evidence] = Field(default_factory=list, max_length=12)
  citations: list[str] = Field(default_factory=list, max_length=20)
  explanation: str = Field(..., min_length=1, max_length=2000)
  confidence: float | None = Field(..., ge=0.0, le=1.0)
  no_answer_reason: str | None = Field(default=None, max_length=256)

  @model_validator(mode="after")
  def validate_semantics_and_grounding(self):
    if len(self.citations) != len(set(self.citations)):
      raise ValueError("citation ids must be unique")
    citation_ids = set(self.citations)
    if any(item.chunk_id not in citation_ids for item in self.evidence):
      raise ValueError("each retrieved evidence chunk must appear in citations")

    if self.status == "classified":
      if self.urgent is None or self.important is None or self.quadrant is None:
        raise ValueError("classified output requires both axes and quadrant")
      expected = {
        (True, True): 0,
        (True, False): 1,
        (False, True): 2,
        (False, False): 3,
      }[(self.urgent, self.important)]
      if self.quadrant != expected:
        raise ValueError("quadrant must match the canonical mapping of urgent and important")
      if self.confidence is None:
        raise ValueError("classified output requires raw confidence")
      if self.no_answer_reason is not None:
        raise ValueError("classified output must not contain no_answer_reason")
    else:
      if any(value is not None for value in (self.urgent, self.important, self.quadrant, self.confidence)):
        raise ValueError("insufficient_evidence must not contain a classification")
      if self.evidence or self.citations:
        raise ValueError("insufficient_evidence must not claim retrieved evidence")
      if not self.no_answer_reason:
        raise ValueError("insufficient_evidence requires no_answer_reason")
    return self


class GenerationResult(StrictFrozenModel):
  output: ClassificationOutput
  execution_id: str = Field(..., pattern=r"^[a-f0-9]{64}$")
  prompt_id: str
  prompt_version: str
  language: Literal["pl", "en"]
  model_id: str
  model_revision: str
  schema_version: str
  input_tokens: int = Field(..., ge=0)
  context_chunk_ids: list[str] = Field(default_factory=list)
