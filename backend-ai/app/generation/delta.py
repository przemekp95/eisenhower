from __future__ import annotations

from difflib import SequenceMatcher
import math
import re
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field

from .models import ClassificationOutput, DeltaClaim, KnownStatement, normalize_statement


class InformationDeltaViolation(ValueError):
  pass


class InformationDeltaPolicy(BaseModel):
  model_config = ConfigDict(extra="forbid", frozen=True)

  policy_version: str = "information-delta-v1"
  duplicate_similarity_min: float = Field(default=0.88, ge=0, le=1)
  new_information_similarity_max: float = Field(default=0.72, ge=0, le=1)
  confirmation_similarity_min: float = Field(default=0.82, ge=0, le=1)
  related_statement_similarity_min: float = Field(default=0.45, ge=0, le=1)
  citation_support_similarity_min: float = Field(default=0.45, ge=0, le=1)


class StatementSimilarity(Protocol):
  @property
  def version(self) -> str: ...

  def compare(self, statement: str, candidates: list[str]) -> list[float]: ...


class LexicalStatementSimilarity:
  version = "unicode-token-char3-v1"

  def compare(self, statement: str, candidates: list[str]) -> list[float]:
    return [self._score(statement, candidate) for candidate in candidates]

  @staticmethod
  def _score(left: str, right: str) -> float:
    normalized_left = normalize_statement(left)
    normalized_right = normalize_statement(right)
    if normalized_left == normalized_right:
      return 1.0
    if not normalized_left or not normalized_right:
      return 0.0
    tokens_left = set(re.findall(r"\w+", normalized_left))
    tokens_right = set(re.findall(r"\w+", normalized_right))
    union = tokens_left | tokens_right
    token_score = len(tokens_left & tokens_right) / len(union) if union else 0.0
    sequence_score = SequenceMatcher(None, normalized_left, normalized_right).ratio()
    trigrams_left = _character_ngrams(normalized_left, 3)
    trigrams_right = _character_ngrams(normalized_right, 3)
    trigram_union = trigrams_left | trigrams_right
    trigram_score = (
      len(trigrams_left & trigrams_right) / len(trigram_union)
      if trigram_union
      else 0.0
    )
    return max(token_score, sequence_score, trigram_score)


class EmbeddingStatementSimilarity:
  def __init__(self, embedding_provider):
    self.embedding_provider = embedding_provider

  @property
  def version(self) -> str:
    return f"cosine:{self.embedding_provider.version}"

  def compare(self, statement: str, candidates: list[str]) -> list[float]:
    if not candidates:
      return []
    vectors = self.embedding_provider.embed([statement, *candidates])
    reference = vectors[0]
    return [_cosine(reference, candidate) for candidate in vectors[1:]]


class InformationDeltaValidator:
  def __init__(
    self,
    similarity: StatementSimilarity,
    policy: InformationDeltaPolicy | None = None,
  ):
    self.similarity = similarity
    self.policy = policy or InformationDeltaPolicy()

  def validate(self, request, output: ClassificationOutput) -> None:
    if not request.delta_requested:
      if output.information_delta is not None:
        raise InformationDeltaViolation("unexpected information delta without explicit known state")
      return
    delta = output.information_delta
    if delta is None:
      raise InformationDeltaViolation("explicit known state requires an information delta")
    if request.freshness_requirement == "current_world_required":
      if (
        delta.status != "freshness_unverified"
        or output.status != "insufficient_evidence"
        or output.citations
        or output.evidence
      ):
        raise InformationDeltaViolation(
          "a frozen corpus must abstain from current-world freshness claims"
        )
      return
    if delta.status == "freshness_unverified":
      raise InformationDeltaViolation(
        "freshness_unverified is reserved for explicit current-world requests"
      )

    known = self._known_statements(request)
    context = {item.chunk_id: item.text for item in request.context}
    output_citations = set(output.citations)
    if not output_citations.issubset(context):
      raise InformationDeltaViolation("output cites a chunk outside the allowed context")

    self._validate_internal_duplicates(delta.claims)
    for claim in delta.claims:
      self._validate_claim(claim, known, context, output_citations)
    self._validate_output_evidence(output, context)

  @staticmethod
  def _known_statements(request) -> dict[str, KnownStatement]:
    statements = (request.known_state or []) + (request.previous_output_statements or [])
    return {item.statement_id: item for item in statements}

  def _validate_internal_duplicates(self, claims: list[DeltaClaim]) -> None:
    for index, claim in enumerate(claims):
      previous = [item.statement for item in claims[:index]]
      if previous and max(self.similarity.compare(claim.statement, previous)) >= (
        self.policy.duplicate_similarity_min
      ):
        raise InformationDeltaViolation("information delta contains semantic duplicate claims")

  def _validate_claim(
    self,
    claim: DeltaClaim,
    known: dict[str, KnownStatement],
    context: dict[str, str],
    output_citations: set[str],
  ) -> None:
    unknown_references = set(claim.compared_to_statement_ids) - set(known)
    if unknown_references:
      raise InformationDeltaViolation("delta claim references unknown known-state ids")
    if not set(claim.citation_ids).issubset(output_citations):
      raise InformationDeltaViolation("delta claim citations must appear in output citations")
    if not set(claim.citation_ids).issubset(context):
      raise InformationDeltaViolation("delta claim cites a chunk outside the allowed context")

    cited_texts = [context[item] for item in claim.citation_ids]
    if cited_texts and max(self.similarity.compare(claim.statement, cited_texts)) < (
      self.policy.citation_support_similarity_min
    ):
      raise InformationDeltaViolation("delta claim is not semantically supported by its citations")

    known_texts = [known[item].statement for item in claim.compared_to_statement_ids]
    if claim.relation == "new_information":
      all_known = [item.statement for item in known.values()]
      if all_known and max(self.similarity.compare(claim.statement, all_known)) >= (
        self.policy.new_information_similarity_max
      ):
        raise InformationDeltaViolation("claimed new information overlaps supplied known state")
      return

    similarities = self.similarity.compare(claim.statement, known_texts)
    if claim.relation in {"confirmation", "necessary_reminder"}:
      if not similarities or max(similarities) < self.policy.confirmation_similarity_min:
        raise InformationDeltaViolation("confirmation or reminder does not match known state")
    elif not similarities or max(similarities) < self.policy.related_statement_similarity_min:
      raise InformationDeltaViolation("update or contradiction is unrelated to referenced state")

  def _validate_output_evidence(
    self,
    output: ClassificationOutput,
    context: dict[str, str],
  ) -> None:
    for evidence in output.evidence:
      source = context.get(evidence.chunk_id)
      if source is None:
        raise InformationDeltaViolation("output evidence references an unknown chunk")
      if self.similarity.compare(evidence.statement, [source])[0] < (
        self.policy.citation_support_similarity_min
      ):
        raise InformationDeltaViolation("output evidence is not supported by its chunk")


def _character_ngrams(value: str, size: int) -> set[str]:
  padded = f" {value} "
  return {padded[index:index + size] for index in range(max(0, len(padded) - size + 1))}


def _cosine(left: list[float], right: list[float]) -> float:
  if len(left) != len(right):
    raise ValueError("embedding dimensions must match")
  denominator = math.sqrt(sum(value * value for value in left)) * math.sqrt(
    sum(value * value for value in right)
  )
  if denominator == 0:
    return 0.0
  score = sum(a * b for a, b in zip(left, right)) / denominator
  return max(-1.0, min(1.0, float(score)))
