from __future__ import annotations

from .models import (
  AccessScope,
  AnalyzeResult,
  Citation,
  GenerationRequest,
  RetrievalQuery,
  RetrievalSummary,
)
from .ports import FallbackClassifier, GenerationProvider, Retriever


QUADRANT_NAMES = {0: "Do Now", 1: "Delegate", 2: "Schedule", 3: "Delete"}


class RagAnalysisService:
  def __init__(
    self,
    retriever: Retriever,
    generator: GenerationProvider,
    fallback_classifier: FallbackClassifier,
    *,
    retrieval_limit: int = 6,
    score_threshold: float = 0.2,
  ):
    self.retriever = retriever
    self.generator = generator
    self.fallback_classifier = fallback_classifier
    self.retrieval_limit = retrieval_limit
    self.score_threshold = score_threshold

  def analyze(self, task: str, scope: AccessScope) -> AnalyzeResult:
    hits = self.retriever.retrieve(
      RetrievalQuery(
        text=task,
        scope=scope,
        limit=self.retrieval_limit,
        score_threshold=self.score_threshold,
      )
    )
    retrieval = RetrievalSummary(
      hit_count=len(hits),
      top_score=hits[0].score if hits else None,
      embedding_version=hits[0].embedding_version if hits else None,
    )
    if not hits:
      return self._fallback(task, retrieval, "no_retrieval_hits")

    try:
      generated = self.generator.generate(GenerationRequest(task=task, context=hits))
    except (TimeoutError, ConnectionError, RuntimeError):
      return self._fallback(task, retrieval, "generation_unavailable")

    hit_by_id = {hit.chunk_id: hit for hit in hits}
    if not generated.cited_chunk_ids or any(
      chunk_id not in hit_by_id for chunk_id in generated.cited_chunk_ids
    ):
      return self._fallback(task, retrieval, "invalid_citations")

    citations = [
      Citation(
        chunk_id=hit.chunk_id,
        document_id=hit.document_id,
        source_uri=hit.source_uri,
        title=hit.title,
        excerpt=hit.text[:280],
        score=hit.score,
        content_version=hit.content_version,
      )
      for hit in (hit_by_id[chunk_id] for chunk_id in generated.cited_chunk_ids)
    ]
    return AnalyzeResult(
      mode="rag",
      quadrant=generated.quadrant,
      quadrant_name=QUADRANT_NAMES[generated.quadrant],
      confidence=generated.confidence,
      explanation=generated.explanation,
      citations=citations,
      retrieval=retrieval,
    )

  def search(self, query: str, scope: AccessScope, *, limit: int = 5) -> dict:
    hits = self.retriever.retrieve(
      RetrievalQuery(
        text=query,
        scope=scope,
        limit=limit,
        score_threshold=self.score_threshold,
      )
    )
    return {
      "query": query,
      "answer": None,
      "citations": [self._citation(hit) for hit in hits],
      "retrieval": RetrievalSummary(
        hit_count=len(hits),
        top_score=hits[0].score if hits else None,
        embedding_version=hits[0].embedding_version if hits else None,
      ),
    }

  @staticmethod
  def _citation(hit) -> Citation:
    return Citation(
      chunk_id=hit.chunk_id,
      document_id=hit.document_id,
      source_uri=hit.source_uri,
      title=hit.title,
      excerpt=hit.text[:280],
      score=hit.score,
      content_version=hit.content_version,
    )

  def _fallback(
    self,
    task: str,
    retrieval: RetrievalSummary,
    reason: str,
  ) -> AnalyzeResult:
    result = self.fallback_classifier.classify_task(task, use_rag=False)
    quadrant = int(result["quadrant"])
    return AnalyzeResult(
      mode="fallback",
      quadrant=quadrant,
      quadrant_name=str(result.get("quadrant_name") or QUADRANT_NAMES[quadrant]),
      confidence=float(result.get("confidence", 0.0)),
      explanation="Local classifier fallback; no grounded generated answer was returned.",
      citations=[],
      retrieval=retrieval,
      fallback_reason=reason,
    )
