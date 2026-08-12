from __future__ import annotations

from datetime import datetime
from hashlib import sha256
import json
import re
from typing import Literal
import unicodedata

from pydantic import BaseModel, ConfigDict, Field, model_validator


SEMVER_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
CHECKSUM_PATTERN = re.compile(r"^[a-f0-9]{64}$")
CONTEXT_POOL_LIMIT = 4800
WORLD_FRESHNESS_SCOPE = "frozen_corpus_snapshot_not_current_world"


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


def normalize_statement(value: str) -> str:
  normalized = unicodedata.normalize("NFC", value).casefold()
  return " ".join(normalized.split())


def statement_checksum(value: str) -> str:
  return sha256(normalize_statement(value).encode("utf-8")).hexdigest()


class KnownStatement(StrictFrozenModel):
  statement_id: str = Field(..., min_length=1, max_length=128)
  statement: str = Field(..., min_length=1, max_length=500)
  language: Literal["pl", "en"]
  checksum: str = Field(..., pattern=r"^[a-f0-9]{64}$")

  @model_validator(mode="after")
  def checksum_matches_statement(self):
    if self.checksum != statement_checksum(self.statement):
      raise ValueError("known statement checksum does not match its normalized text")
    return self


class DeltaClaim(StrictFrozenModel):
  claim_id: str = Field(..., min_length=1, max_length=128)
  statement: str = Field(..., min_length=1, max_length=500)
  relation: Literal[
    "new_information",
    "confirmation",
    "contradiction",
    "update",
    "necessary_reminder",
  ]
  compared_to_statement_ids: list[str] = Field(default_factory=list, max_length=20)
  citation_ids: list[str] = Field(default_factory=list, max_length=20)
  reminder_reason: Literal[
    "direct_answer",
    "decision_constraint",
    "safety_constraint",
  ] | None = None

  @model_validator(mode="after")
  def relation_shape_is_explicit(self):
    if len(self.compared_to_statement_ids) != len(set(self.compared_to_statement_ids)):
      raise ValueError("compared known statement ids must be unique")
    if len(self.citation_ids) != len(set(self.citation_ids)):
      raise ValueError("delta claim citation ids must be unique")
    if self.relation == "new_information":
      if self.compared_to_statement_ids or not self.citation_ids:
        raise ValueError("new information requires citations and cannot reference known statements")
    elif self.relation == "necessary_reminder":
      if not self.compared_to_statement_ids or self.reminder_reason is None:
        raise ValueError("necessary reminder requires known references and an explicit reason")
    elif not self.compared_to_statement_ids or not self.citation_ids:
      raise ValueError(f"{self.relation} requires known references and citations")
    if self.relation != "necessary_reminder" and self.reminder_reason is not None:
      raise ValueError("reminder_reason is valid only for necessary reminders")
    return self


class InformationDelta(StrictFrozenModel):
  status: Literal[
    "new_information",
    "mixed",
    "confirmation_only",
    "no_new_information",
    "freshness_unverified",
  ]
  claims: list[DeltaClaim] = Field(default_factory=list, max_length=12)
  summary_code: Literal[
    "grounded_delta_available",
    "known_information_only",
    "no_new_information",
    "current_world_freshness_unverified",
  ]
  world_freshness: Literal[WORLD_FRESHNESS_SCOPE] = WORLD_FRESHNESS_SCOPE

  @model_validator(mode="after")
  def status_matches_claims(self):
    if len({claim.claim_id for claim in self.claims}) != len(self.claims):
      raise ValueError("delta claim ids must be unique")
    relations = {claim.relation for claim in self.claims}
    knowledge_changing = {"new_information", "contradiction", "update"}
    if self.status in {"no_new_information", "freshness_unverified"} and self.claims:
      raise ValueError(f"{self.status} must not contain claims")
    if self.status == "new_information" and (
      not self.claims or relations != {"new_information"}
    ):
      raise ValueError("new_information status requires only new-information claims")
    if self.status == "confirmation_only" and (
      not self.claims or not relations.issubset({"confirmation", "necessary_reminder"})
    ):
      raise ValueError("confirmation_only requires confirmations or necessary reminders")
    if self.status == "mixed" and (
      len(relations) < 2 or not (relations & knowledge_changing)
    ):
      raise ValueError("mixed status requires multiple relations including a knowledge change")
    expected_summary = {
      "new_information": "grounded_delta_available",
      "mixed": "grounded_delta_available",
      "confirmation_only": "known_information_only",
      "no_new_information": "no_new_information",
      "freshness_unverified": "current_world_freshness_unverified",
    }[self.status]
    if self.summary_code != expected_summary:
      raise ValueError("information delta summary code must match its status")
    return self


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
  information_delta: InformationDelta | None = None

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
      if self.information_delta is not None and self.information_delta.status not in {
        "no_new_information",
        "freshness_unverified",
      }:
        raise ValueError("insufficient_evidence may only report no delta or unverified freshness")
    return self


class KnowledgeAnswerClaim(StrictFrozenModel):
  statement: str = Field(..., min_length=1, max_length=1000)
  citation_ids: list[str] = Field(..., min_length=1, max_length=12)

  @model_validator(mode="after")
  def citation_ids_are_unique(self):
    if len(self.citation_ids) != len(set(self.citation_ids)):
      raise ValueError("knowledge claim citation ids must be unique")
    return self


class KnowledgeAnswerOutput(StrictFrozenModel):
  status: Literal["answered", "insufficient_evidence"]
  answer: str | None = Field(default=None, max_length=4000)
  claims: list[KnowledgeAnswerClaim] = Field(default_factory=list, max_length=12)
  citations: list[str] = Field(default_factory=list, max_length=20)
  no_answer_reason: Literal[
    "none",
    "insufficient_context",
    "conflicting_context",
    "unsupported_query",
    "prompt_injection_detected",
  ]

  @model_validator(mode="after")
  def answer_shape_is_grounded(self):
    if len(self.citations) != len(set(self.citations)):
      raise ValueError("knowledge answer citation ids must be unique")
    used_citations = {
      citation_id for claim in self.claims for citation_id in claim.citation_ids
    }
    if self.status == "answered":
      if not self.answer or not str(self.answer).strip():
        raise ValueError("answered output requires a non-empty answer")
      if not self.claims or not self.citations:
        raise ValueError("answered output requires claims and citations")
      if used_citations != set(self.citations):
        raise ValueError("answer citations must exactly match claim citations")
      if self.no_answer_reason != "none":
        raise ValueError("answered output requires no_answer_reason=none")
    else:
      if self.answer is not None or self.claims or self.citations:
        raise ValueError("insufficient_evidence must not contain answer content")
      if self.no_answer_reason == "none":
        raise ValueError("insufficient_evidence requires a concrete no_answer_reason")
    return self


class KnowledgeAnswerDecision(StrictFrozenModel):
  status: Literal["answered", "insufficient_evidence"]


class KnowledgeGroundedAnswer(StrictFrozenModel):
  status: Literal["answered"]
  answer: str = Field(..., min_length=1, max_length=4000)
  citation_id: str = Field(..., min_length=1, max_length=256)
  no_answer_reason: Literal["none"]


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


class KnowledgeAnswerResult(StrictFrozenModel):
  output: KnowledgeAnswerOutput
  execution_id: str = Field(..., pattern=r"^[a-f0-9]{64}$")
  prompt_id: str
  prompt_version: str
  language: Literal["pl", "en"]
  model_id: str
  model_revision: str
  schema_version: str
  input_tokens: int = Field(..., ge=0)
  context_chunk_ids: list[str] = Field(default_factory=list)
