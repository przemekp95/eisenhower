from __future__ import annotations

from collections import Counter
from math import isfinite, log
from statistics import fmean, stdev
import re
from typing import Protocol, Sequence

import httpx

from .adapters import is_private_service_url
from .canonical import CanonicalDocumentStore, canonical_document_is_visible
from .errors import RerankerUnavailable
from .ingestion import DeterministicChunker, build_chunk_records
from .models import RetrievalHit, RetrievalQuery
from .ports import Retriever


_TOKEN_PATTERN = re.compile(r"\w+", flags=re.UNICODE)
_BM25_K1 = 1.2
_BM25_B = 0.75
_DEFAULT_TITLE_WEIGHT = 2.0
_DEFAULT_TEXT_WEIGHT = 1.0
_DEFAULT_DENSE_RRF_WEIGHT = 1.0
_DEFAULT_LEXICAL_RRF_WEIGHT = 1.5
_MAX_RANKING_WEIGHT = 10.0
_MAX_RERANKER_CANDIDATES = 20
_EVALUATED_RERANKER_MODEL = "BAAI/bge-reranker-v2-m3"
_EVALUATED_RERANKER_REVISION = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"
_EVALUATED_RERANKER_MODEL_ID = f"{_EVALUATED_RERANKER_MODEL}@{_EVALUATED_RERANKER_REVISION}"
_EVALUATED_RERANKER_MAX_TOKENS = 192


class HybridRetrievalError(RuntimeError):
  pass


class CandidateScopeViolation(HybridRetrievalError):
  pass


class InvalidCandidateSet(HybridRetrievalError):
  pass


class Reranker(Protocol):
  def score(
    self,
    query_text: str,
    ranked_candidates: tuple[RetrievalHit, ...],
  ) -> Sequence[float]: ...


class PrivateVllmReranker:
  """Authenticated fail-closed adapter for the evaluated private vLLM score service."""

  model_id = _EVALUATED_RERANKER_MODEL_ID
  model_name = _EVALUATED_RERANKER_MODEL
  revision = _EVALUATED_RERANKER_REVISION
  max_model_len = _EVALUATED_RERANKER_MAX_TOKENS

  def __init__(
    self,
    base_url: str,
    api_key: str,
    *,
    allowed_hosts: tuple[str, ...] = (),
    client: httpx.Client | None = None,
  ):
    if not is_private_service_url(base_url, allowed_hosts=allowed_hosts):
      raise ValueError("Reranker must use a fixed private-network endpoint")
    if not api_key:
      raise ValueError("RERANKER_API_KEY is required for hybrid-bge-v1")
    self.base_url = base_url.rstrip("/")
    self.api_key = api_key
    self.client = client or httpx.Client(
      timeout=httpx.Timeout(connect=2.0, read=30.0, write=5.0, pool=1.0),
      follow_redirects=False,
    )
    self._verify_runtime()

  @property
  def _headers(self) -> dict[str, str]:
    return {"Authorization": f"Bearer {self.api_key}"}

  def _verify_runtime(self) -> None:
    try:
      response = self.client.get(f"{self.base_url}/v1/models", headers=self._headers)
      response.raise_for_status()
      models = response.json()["data"]
      if len(models) != 1:
        raise ValueError
      model = models[0]
      if model["id"] != self.model_id or int(model["max_model_len"]) != self.max_model_len:
        raise ValueError
    except (httpx.HTTPError, KeyError, TypeError, ValueError) as error:
      raise ValueError(
        "Reranker endpoint does not expose the evaluated model revision and 192-token bound"
      ) from error

  def score(
    self,
    query_text: str,
    ranked_candidates: tuple[RetrievalHit, ...],
  ) -> Sequence[float]:
    if len(ranked_candidates) > _MAX_RERANKER_CANDIDATES:
      raise RerankerUnavailable("reranker candidate bound exceeded")
    try:
      response = self.client.post(
        f"{self.base_url}/v1/score",
        headers=self._headers,
        json={
          "model": self.model_id,
          "text_1": query_text,
          "text_2": [f"{candidate.title}\n{candidate.text}" for candidate in ranked_candidates],
          "truncate_prompt_tokens": self.max_model_len,
        },
      )
      response.raise_for_status()
      data = sorted(response.json()["data"], key=lambda item: item["index"])
      indexes = [item["index"] for item in data]
      scores = [item["score"] for item in data]
      if indexes != list(range(len(ranked_candidates))):
        raise ValueError
      if any(
        isinstance(score, bool)
        or not isinstance(score, (int, float))
        or not isfinite(float(score))
        for score in scores
      ):
        raise ValueError
      return [float(score) for score in scores]
    except httpx.HTTPError as error:
      raise RerankerUnavailable("reranker request failed") from error
    except (KeyError, TypeError, ValueError) as error:
      raise RerankerUnavailable("reranker returned an invalid response") from error


class HybridRetrievalCore:
  """Fuses canonical dense and lexical rankings, then optionally reranks."""

  def __init__(
    self,
    *,
    rrf_k: int = 60,
    dense_rrf_weight: float = _DEFAULT_DENSE_RRF_WEIGHT,
    lexical_rrf_weight: float = _DEFAULT_LEXICAL_RRF_WEIGHT,
    fusion_mode: str = "rrf",
    title_weight: float = _DEFAULT_TITLE_WEIGHT,
    text_weight: float = _DEFAULT_TEXT_WEIGHT,
    reranker: Reranker | None = None,
    reranker_candidate_limit: int = 20,
    reranker_weight: float = 1.0,
  ):
    if rrf_k < 1:
      raise ValueError("rrf_k must be positive")
    self._validate_weight("dense_rrf_weight", dense_rrf_weight)
    self._validate_weight("lexical_rrf_weight", lexical_rrf_weight)
    if fusion_mode not in {"rrf", "dbsf"}:
      raise ValueError("fusion_mode must be 'rrf' or 'dbsf'")
    self._validate_weight("title_weight", title_weight)
    self._validate_weight("text_weight", text_weight)
    if not 1 <= reranker_candidate_limit <= _MAX_RERANKER_CANDIDATES:
      raise ValueError("reranker_candidate_limit must be between 1 and 20")
    if not 0 < reranker_weight <= 1:
      raise ValueError("reranker_weight must be between 0 and 1")
    self.rrf_k = rrf_k
    self.dense_rrf_weight = float(dense_rrf_weight)
    self.lexical_rrf_weight = float(lexical_rrf_weight)
    self.fusion_mode = fusion_mode
    self.title_weight = float(title_weight)
    self.text_weight = float(text_weight)
    self.reranker = reranker
    self.reranker_candidate_limit = reranker_candidate_limit
    self.reranker_weight = float(reranker_weight)

  def rank(
    self,
    query: RetrievalQuery,
    dense_candidates: Sequence[RetrievalHit],
    lexical_candidates: Sequence[RetrievalHit] | None = None,
  ) -> list[RetrievalHit]:
    self._validate_candidates(query, dense_candidates)
    if lexical_candidates is None:
      lexical_candidates = dense_candidates
      lexical_scores = self._bm25_scores(
        query.text,
        lexical_candidates,
        title_weight=self.title_weight,
        text_weight=self.text_weight,
      )
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
    return self._diversify_documents(ranked)[:query.limit]

  def _fuse(
    self,
    dense_order: Sequence[RetrievalHit],
    lexical_order: Sequence[RetrievalHit],
  ) -> list[RetrievalHit]:
    if self.fusion_mode == "dbsf":
      return self._fuse_dbsf(dense_order, lexical_order)
    candidates = {item.chunk_id: item for item in lexical_order}
    candidates.update({item.chunk_id: item for item in dense_order})
    scores = {chunk_id: 0.0 for chunk_id in candidates}
    weighted_rankings = (
      (dense_order, self.dense_rrf_weight),
      (lexical_order, self.lexical_rrf_weight),
    )
    for ranking, weight in weighted_rankings:
      for rank, item in enumerate(ranking, start=1):
        scores[item.chunk_id] += weight / (self.rrf_k + rank)

    fused = [
      item.model_copy(update={"score": scores[item.chunk_id]})
      for item in candidates.values()
    ]
    return sorted(
      fused,
      key=lambda item: (-item.score, item.chunk_id, item.document_id),
    )

  def _fuse_dbsf(
    self,
    dense_order: Sequence[RetrievalHit],
    lexical_order: Sequence[RetrievalHit],
  ) -> list[RetrievalHit]:
    candidates = {item.chunk_id: item for item in lexical_order}
    candidates.update({item.chunk_id: item for item in dense_order})
    scores = {chunk_id: 0.0 for chunk_id in candidates}
    for ranking, weight in (
      (dense_order, self.dense_rrf_weight),
      (lexical_order, self.lexical_rrf_weight),
    ):
      normalized = self._dbsf_scores([item.score for item in ranking])
      for item, score in zip(ranking, normalized, strict=True):
        scores[item.chunk_id] += weight * score
    fused = [
      item.model_copy(update={"score": scores[item.chunk_id]})
      for item in candidates.values()
    ]
    return sorted(fused, key=lambda item: (-item.score, item.chunk_id, item.document_id))

  @staticmethod
  def _dbsf_scores(scores: Sequence[float]) -> list[float]:
    if len(scores) < 2:
      return [0.5 for _ in scores]
    deviation = stdev(scores)
    if deviation == 0:
      return [0.5 for _ in scores]
    center = fmean(scores)
    lower = center - (3 * deviation)
    span = 6 * deviation
    return [(score - lower) / span for score in scores]

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

    fused_scores = self._normalize_scores([item.score for item in prefix])
    cross_scores = self._normalize_scores([float(score) for score in raw_scores])
    reranked = [item.model_copy(update={"score": (
      (1 - self.reranker_weight) * fused_scores[index]
      + self.reranker_weight * cross_scores[index]
    )}) for index, item in enumerate(prefix)]
    reranked.sort(
      key=lambda item: (-item.score, self._rank_of(item.chunk_id, prefix), item.chunk_id),
    )
    return reranked + fused[prefix_size:]

  @staticmethod
  def _normalize_scores(scores: Sequence[float]) -> list[float]:
    minimum = min(scores)
    span = max(scores) - minimum
    if span == 0:
      return [0.0 for _ in scores]
    return [(score - minimum) / span for score in scores]

  @staticmethod
  def _diversify_documents(ranked: Sequence[RetrievalHit]) -> list[RetrievalHit]:
    first_chunks: list[RetrievalHit] = []
    additional_chunks: list[RetrievalHit] = []
    seen_document_ids: set[str] = set()
    for item in ranked:
      if item.document_id in seen_document_ids:
        additional_chunks.append(item)
        continue
      seen_document_ids.add(item.document_id)
      first_chunks.append(item)
    return first_chunks + additional_chunks

  @staticmethod
  def _rank_of(chunk_id: str, candidates: Sequence[RetrievalHit]) -> int:
    return next(index for index, item in enumerate(candidates) if item.chunk_id == chunk_id)

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
    *,
    title_weight: float = _DEFAULT_TITLE_WEIGHT,
    text_weight: float = _DEFAULT_TEXT_WEIGHT,
  ) -> dict[str, float]:
    cls._validate_weight("title_weight", title_weight)
    cls._validate_weight("text_weight", text_weight)
    tokenized_fields = {
      item.chunk_id: {
        "title": cls._tokens(item.title),
        "text": cls._tokens(item.text),
      }
      for item in candidates
    }
    query_terms = set(cls._tokens(query_text))
    average_lengths = {
      field_name: sum(
        len(fields[field_name]) for fields in tokenized_fields.values()
      ) / len(tokenized_fields)
      for field_name in ("title", "text")
    }
    field_weights = {"title": float(title_weight), "text": float(text_weight)}
    scores = {item.chunk_id: 0.0 for item in candidates}
    for term in query_terms:
      document_frequency = sum(
        any(term in tokens for tokens in fields.values())
        for fields in tokenized_fields.values()
      )
      if document_frequency == 0:
        continue
      inverse_document_frequency = log(
        1 + ((len(candidates) - document_frequency + 0.5) / (document_frequency + 0.5))
      )
      for chunk_id, fields in tokenized_fields.items():
        for field_name, tokens in fields.items():
          term_frequency = Counter(tokens)[term]
          if term_frequency == 0:
            continue
          average_length = average_lengths[field_name]
          length_ratio = len(tokens) / average_length if average_length else 0.0
          denominator = term_frequency + (
            _BM25_K1 * (1 - _BM25_B + (_BM25_B * length_ratio))
          )
          scores[chunk_id] += field_weights[field_name] * inverse_document_frequency * (
            (term_frequency * (_BM25_K1 + 1)) / denominator
          )
    return scores

  @staticmethod
  def _validate_weight(name: str, value: float) -> None:
    if (
      isinstance(value, bool)
      or not isinstance(value, (int, float))
      or not isfinite(float(value))
      or not 0 < float(value) <= _MAX_RANKING_WEIGHT
    ):
      raise ValueError(f"{name} must be finite and between 0 and 10")

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
    title_weight: float = _DEFAULT_TITLE_WEIGHT,
    text_weight: float = _DEFAULT_TEXT_WEIGHT,
  ):
    HybridRetrievalCore._validate_weight("title_weight", title_weight)
    HybridRetrievalCore._validate_weight("text_weight", text_weight)
    self.document_store = document_store
    self.embedding_version = embedding_version
    self.chunker = chunker or DeterministicChunker()
    self.title_weight = float(title_weight)
    self.text_weight = float(text_weight)

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
    scores = HybridRetrievalCore._bm25_scores(
      query.text,
      candidates,
      title_weight=self.title_weight,
      text_weight=self.text_weight,
    )
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
  """Composes canonical dense and lexical retrievers with weighted RRF."""

  def __init__(
    self,
    dense_retriever: Retriever,
    lexical_retriever: Retriever,
    *,
    rrf_k: int = 60,
    dense_rrf_weight: float = _DEFAULT_DENSE_RRF_WEIGHT,
    lexical_rrf_weight: float = _DEFAULT_LEXICAL_RRF_WEIGHT,
    fusion_mode: str = "rrf",
    candidate_multiplier: int = 4,
    reranker: Reranker | None = None,
    reranker_candidate_limit: int = 20,
    reranker_weight: float = 1.0,
  ):
    if candidate_multiplier < 1:
      raise ValueError("candidate_multiplier must be positive")
    self.dense_retriever = dense_retriever
    self.lexical_retriever = lexical_retriever
    self.candidate_multiplier = candidate_multiplier
    self.core = HybridRetrievalCore(
      rrf_k=rrf_k,
      dense_rrf_weight=dense_rrf_weight,
      lexical_rrf_weight=lexical_rrf_weight,
      fusion_mode=fusion_mode,
      reranker=reranker,
      reranker_candidate_limit=reranker_candidate_limit,
      reranker_weight=reranker_weight,
    )

  def retrieve(self, query: RetrievalQuery) -> list[RetrievalHit]:
    candidate_limit = min(20, max(query.limit, query.limit * self.candidate_multiplier))
    candidate_query = query.model_copy(update={"limit": candidate_limit})
    dense_candidates = self.dense_retriever.retrieve(candidate_query)
    lexical_candidates = self.lexical_retriever.retrieve(candidate_query)
    return self.core.rank(query, dense_candidates, lexical_candidates)
