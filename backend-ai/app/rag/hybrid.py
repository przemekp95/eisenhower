from __future__ import annotations

from collections import Counter
from math import isfinite, log
import re
from typing import Protocol, Sequence

from .canonical import CanonicalDocumentStore, canonical_document_is_visible
from .ingestion import DeterministicChunker, build_chunk_records
from .models import RetrievalHit, RetrievalQuery
from .ports import Retriever


_TOKEN_PATTERN = re.compile(r"\w+", flags=re.UNICODE)
_BM25_K1 = 1.2
_BM25_B = 0.75
_MAX_RERANKER_CANDIDATES = 20


class HybridRetrievalError(RuntimeError):
  pass


class CandidateScopeViolation(HybridRetrievalError):
  pass


class InvalidCandidateSet(HybridRetrievalError):
  pass


class RerankerUnavailable(HybridRetrievalError):
  pass


class Reranker(Protocol):
  def score(
    self,
    query_text: str,
    ranked_candidates: tuple[RetrievalHit, ...],
  ) -> Sequence[float]: ...


class SentenceTransformerCrossEncoderReranker:
  """Bounded adapter for an already pinned and loaded CrossEncoder model."""

  def __init__(self, model, *, batch_size: int = 4):
    if not 1 <= batch_size <= _MAX_RERANKER_CANDIDATES:
      raise ValueError("reranker batch_size must be between 1 and 20")
    self.model = model
    self.batch_size = batch_size

  def score(
    self,
    query_text: str,
    ranked_candidates: tuple[RetrievalHit, ...],
  ) -> list[float]:
    pairs = [
      [query_text, f"{candidate.title}\n{candidate.text}"]
      for candidate in ranked_candidates
    ]
    raw_scores = self.model.predict(
      pairs,
      batch_size=self.batch_size,
      show_progress_bar=False,
      convert_to_numpy=True,
    )
    return [float(score) for score in raw_scores]


class HybridRetrievalCore:
  """Fuses canonical dense and lexical rankings, then optionally reranks."""

  def __init__(
    self,
    *,
    rrf_k: int = 60,
    reranker: Reranker | None = None,
    reranker_candidate_limit: int = 20,
  ):
    if rrf_k < 1:
      raise ValueError("rrf_k must be positive")
    if not 1 <= reranker_candidate_limit <= _MAX_RERANKER_CANDIDATES:
      raise ValueError("reranker_candidate_limit must be between 1 and 20")
    self.rrf_k = rrf_k
    self.reranker = reranker
    self.reranker_candidate_limit = reranker_candidate_limit

  def rank(
    self,
    query: RetrievalQuery,
    dense_candidates: Sequence[RetrievalHit],
    lexical_candidates: Sequence[RetrievalHit] | None = None,
  ) -> list[RetrievalHit]:
    self._validate_candidates(query, dense_candidates)
    if lexical_candidates is None:
      lexical_candidates = dense_candidates
      lexical_scores = self._bm25_scores(query.text, lexical_candidates)
    else:
      self._validate_candidates(query, lexical_candidates)
      lexical_scores = {item.chunk_id: item.score for item in lexical_candidates}
    self._validate_shared_candidates(dense_candidates, lexical_candidates)
    if not dense_candidates and not lexical_candidates:
      return []

    dense_order = sorted(
      dense_candidates,
      key=lambda item: (-item.score, item.chunk_id, item.document_id),
    )
    lexical_order = sorted(
      lexical_candidates,
      key=lambda item: (-lexical_scores[item.chunk_id], item.chunk_id, item.document_id),
    )
    fused = self._fuse(dense_order, lexical_order)
    ranked = self._rerank(query.text, fused) if self.reranker is not None else fused
    return ranked[:query.limit]

  def _fuse(
    self,
    dense_order: Sequence[RetrievalHit],
    lexical_order: Sequence[RetrievalHit],
  ) -> list[RetrievalHit]:
    candidates = {item.chunk_id: item for item in lexical_order}
    candidates.update({item.chunk_id: item for item in dense_order})
    scores = {chunk_id: 0.0 for chunk_id in candidates}
    for ranking in (dense_order, lexical_order):
      for rank, item in enumerate(ranking, start=1):
        scores[item.chunk_id] += 1 / (self.rrf_k + rank)

    fused = [
      item.model_copy(update={"score": scores[item.chunk_id]})
      for item in candidates.values()
    ]
    return sorted(
      fused,
      key=lambda item: (-item.score, item.chunk_id, item.document_id),
    )

  def _rerank(self, query_text: str, fused: list[RetrievalHit]) -> list[RetrievalHit]:
    reranker = self.reranker
    if reranker is None:
      return fused
    prefix_size = min(self.reranker_candidate_limit, len(fused))
    prefix = tuple(fused[:prefix_size])
    try:
      raw_scores = reranker.score(query_text, prefix)
    except Exception as error:
      raise RerankerUnavailable("reranker provider failed") from error
    if not isinstance(raw_scores, Sequence) or len(raw_scores) != prefix_size:
      raise RerankerUnavailable("reranker returned an invalid score count")
    if any(
      isinstance(score, bool)
      or not isinstance(score, (int, float))
      or not isfinite(float(score))
      for score in raw_scores
    ):
      raise RerankerUnavailable("reranker returned a non-finite score")

    reranker_order = sorted(
      range(prefix_size),
      key=lambda index: (-float(raw_scores[index]), index, prefix[index].chunk_id),
    )
    reranker_rank = {
      prefix[index].chunk_id: rank
      for rank, index in enumerate(reranker_order, start=1)
    }
    original_rank = {
      item.chunk_id: rank
      for rank, item in enumerate(prefix, start=1)
    }
    reranked = [
      item.model_copy(update={
        "score": (
          (1 / (self.rrf_k + original_rank[item.chunk_id]))
          + (1 / (self.rrf_k + reranker_rank[item.chunk_id]))
        )
      })
      for item in prefix
    ]
    reranked.sort(key=lambda item: (
      -item.score,
      reranker_rank[item.chunk_id],
      original_rank[item.chunk_id],
      item.chunk_id,
    ))
    return reranked + fused[prefix_size:]

  @staticmethod
  def _validate_candidates(
    query: RetrievalQuery,
    candidates: Sequence[RetrievalHit],
  ) -> None:
    chunk_ids: set[str] = set()
    for candidate in candidates:
      if not isfinite(candidate.score):
        raise InvalidCandidateSet("candidate score must be finite")
      if candidate.chunk_id in chunk_ids:
        raise InvalidCandidateSet("canonical candidate chunk ids must be unique")
      chunk_ids.add(candidate.chunk_id)
      if candidate.tenant_id != query.scope.tenant_id:
        raise CandidateScopeViolation("candidate tenant is outside the authorized scope")
      if candidate.project_id is not None and candidate.project_id not in query.scope.project_ids:
        raise CandidateScopeViolation("candidate project is outside the authorized scope")
      if query.project_id is not None and candidate.project_id != query.project_id:
        raise CandidateScopeViolation("candidate does not match the requested project")

  @staticmethod
  def _validate_shared_candidates(
    dense_candidates: Sequence[RetrievalHit],
    lexical_candidates: Sequence[RetrievalHit],
  ) -> None:
    dense_by_chunk = {item.chunk_id: item for item in dense_candidates}
    for lexical in lexical_candidates:
      dense = dense_by_chunk.get(lexical.chunk_id)
      if dense is not None and dense.model_dump(exclude={"score"}) != lexical.model_dump(
        exclude={"score"}
      ):
        raise InvalidCandidateSet("dense and lexical candidate metadata must match")

  @classmethod
  def _bm25_scores(
    cls,
    query_text: str,
    candidates: Sequence[RetrievalHit],
  ) -> dict[str, float]:
    tokenized = {
      item.chunk_id: cls._tokens(f"{item.title} {item.text}")
      for item in candidates
    }
    query_terms = set(cls._tokens(query_text))
    average_length = sum(len(tokens) for tokens in tokenized.values()) / len(tokenized)
    scores = {item.chunk_id: 0.0 for item in candidates}
    for term in query_terms:
      document_frequency = sum(term in tokens for tokens in tokenized.values())
      if document_frequency == 0:
        continue
      inverse_document_frequency = log(
        1 + ((len(candidates) - document_frequency + 0.5) / (document_frequency + 0.5))
      )
      for chunk_id, tokens in tokenized.items():
        term_frequency = Counter(tokens)[term]
        if term_frequency == 0:
          continue
        length_ratio = len(tokens) / average_length if average_length else 0.0
        denominator = term_frequency + (_BM25_K1 * (1 - _BM25_B + (_BM25_B * length_ratio)))
        scores[chunk_id] += inverse_document_frequency * (
          (term_frequency * (_BM25_K1 + 1)) / denominator
        )
    return scores

  @staticmethod
  def _tokens(text: str) -> list[str]:
    return _TOKEN_PATTERN.findall(text.casefold())


class CanonicalBm25Retriever:
  """Builds a lexical ranking only from current, visible canonical chunks."""

  def __init__(
    self,
    document_store: CanonicalDocumentStore,
    *,
    embedding_version: str,
    chunker: DeterministicChunker | None = None,
  ):
    self.document_store = document_store
    self.embedding_version = embedding_version
    self.chunker = chunker or DeterministicChunker()

  def retrieve(self, query: RetrievalQuery) -> list[RetrievalHit]:
    enumerated = self.document_store.project_documents(
      query.scope.tenant_id,
      query.project_id,
    )
    candidates: list[RetrievalHit] = []
    seen_document_ids: set[str] = set()
    for enumerated_document in enumerated:
      if enumerated_document.document_id in seen_document_ids:
        continue
      seen_document_ids.add(enumerated_document.document_id)
      state = self.document_store.retrieval_state(
        query.scope.tenant_id,
        enumerated_document.document_id,
      )
      if state is None or state.projection_pending:
        continue
      document = state.document
      if not canonical_document_is_visible(document, query):
        continue
      for chunk in build_chunk_records(
        document,
        self.chunker,
        embedding_version=self.embedding_version,
      ):
        candidates.append(RetrievalHit(
          chunk_id=chunk.chunk_id,
          document_id=chunk.document_id,
          text=chunk.text,
          score=0.0,
          source_uri=chunk.source_uri,
          title=chunk.title,
          tenant_id=chunk.tenant_id,
          project_id=chunk.project_id,
          owner_id=chunk.owner_id,
          embedding_version=chunk.embedding_version,
          content_version=chunk.content_version,
          source_type=chunk.source_type,
        ))
    if not candidates:
      return []
    scores = HybridRetrievalCore._bm25_scores(query.text, candidates)
    ranked = [
      candidate.model_copy(update={"score": scores[candidate.chunk_id]})
      for candidate in candidates
      if scores[candidate.chunk_id] > 0
      and scores[candidate.chunk_id] >= query.score_threshold
    ]
    return sorted(
      ranked,
      key=lambda item: (-item.score, item.chunk_id, item.document_id),
    )[:query.limit]


class HybridRetriever:
  """Composes canonical dense and lexical retrievers with equal RRF weight."""

  def __init__(
    self,
    dense_retriever: Retriever,
    lexical_retriever: Retriever,
    *,
    rrf_k: int = 60,
    candidate_multiplier: int = 20,
    reranker: Reranker | None = None,
    reranker_candidate_limit: int = 20,
  ):
    if candidate_multiplier < 1:
      raise ValueError("candidate_multiplier must be positive")
    self.dense_retriever = dense_retriever
    self.lexical_retriever = lexical_retriever
    self.candidate_multiplier = candidate_multiplier
    self.core = HybridRetrievalCore(
      rrf_k=rrf_k,
      reranker=reranker,
      reranker_candidate_limit=reranker_candidate_limit,
    )

  def retrieve(self, query: RetrievalQuery) -> list[RetrievalHit]:
    candidate_limit = min(100, max(query.limit, query.limit * self.candidate_multiplier))
    candidate_query = query.model_copy(update={"limit": candidate_limit})
    dense_candidates = self._best_per_document(
      self.dense_retriever.retrieve(candidate_query)
    )
    lexical_candidates = self._best_per_document(
      self.lexical_retriever.retrieve(candidate_query)
    )
    lexical_by_document = {item.document_id: item for item in lexical_candidates}
    dense_candidates = [
      lexical_by_document[item.document_id].model_copy(update={"score": item.score})
      if item.document_id in lexical_by_document else item
      for item in dense_candidates
    ]
    ranked = self.core.rank(candidate_query, dense_candidates, lexical_candidates)
    diversified: list[RetrievalHit] = []
    seen_documents: set[str] = set()
    for candidate in ranked:
      if candidate.document_id in seen_documents:
        continue
      seen_documents.add(candidate.document_id)
      diversified.append(candidate)
      if len(diversified) == query.limit:
        break
    return diversified

  @staticmethod
  def _best_per_document(candidates: Sequence[RetrievalHit]) -> list[RetrievalHit]:
    selected: list[RetrievalHit] = []
    seen_documents: set[str] = set()
    for candidate in candidates:
      if candidate.document_id in seen_documents:
        continue
      seen_documents.add(candidate.document_id)
      selected.append(candidate)
    return selected
