from __future__ import annotations

from .models import (
  AccessScope,
  AnalyzeResult,
  Citation,
  GenerationMetadata,
  GenerationRequest,
  RetrievalQuery,
  RetrievalSummary,
)
from .errors import GenerationProviderError
from .ports import FallbackClassifier, GenerationProvider, Retriever


QUADRANT_NAMES = {0: "Do Now", 1: "Delegate", 2: "Schedule", 3: "Delete"}


class RagAnalysisService:
  def __init__(
    self,
    retriever: Retriever,
    generator: GenerationProvider | None,
    fallback_classifier: FallbackClassifier,
    *,
    retrieval_limit: int = 6,
    score_threshold: float = 0.2,
    retrieval_version: str = "retrieval-v1",
    index_version: str = "index-v1",
  ):
    self.retriever = retriever
    self.generator = generator
    self.fallback_classifier = fallback_classifier
    self.retrieval_limit = retrieval_limit
    self.score_threshold = score_threshold
    self.retrieval_version = retrieval_version
    self.index_version = index_version

  @property
  def generation_enabled(self) -> bool:
    return self.generator is not None

  def analyze(self, task: str, scope: AccessScope, *, language: str = "en") -> AnalyzeResult:
    hits, retrieval = self._retrieve(task, scope, limit=self.retrieval_limit)
    if not hits:
      return self._fallback(task, retrieval, "no_retrieval_hits")
    if self.generator is None:
      return self._fallback(task, retrieval, "generation_disabled")

    try:
      generated = self.generator.generate(
        GenerationRequest(
          task=task,
          context=hits,
          language=language,
          retrieval_version=self.retrieval_version,
          index_version=self.index_version,
        )
      )
    except GenerationProviderError:
      return self._fallback(task, retrieval, "generation_unavailable")

    output = generated.output
    generation = GenerationMetadata(
      execution_id=generated.execution_id,
      prompt_id=generated.prompt_id,
      prompt_version=generated.prompt_version,
      model_id=generated.model_id,
      model_revision=generated.model_revision,
      schema_version=generated.schema_version,
      language=generated.language,
      input_tokens=generated.input_tokens,
    )
    if output.status == "insufficient_evidence":
      return AnalyzeResult(
        mode="no_answer",
        explanation=output.explanation,
        citations=[],
        retrieval=retrieval,
        generation=generation,
        fallback_reason=output.no_answer_reason,
      )

    hit_by_id = {hit.chunk_id: hit for hit in hits}
    if not output.citations or any(
      chunk_id not in hit_by_id for chunk_id in output.citations
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
      for hit in (hit_by_id[chunk_id] for chunk_id in output.citations)
    ]
    return AnalyzeResult(
      mode="rag",
      quadrant=output.quadrant,
      quadrant_name=QUADRANT_NAMES[output.quadrant],
      confidence=output.confidence,
      explanation=output.explanation,
      citations=citations,
      retrieval=retrieval,
      generation=generation,
    )

  def retrieve_summary(self, query: str, scope: AccessScope) -> RetrievalSummary:
    _, summary = self._retrieve(query, scope, limit=self.retrieval_limit)
    return summary

  def search(
    self,
    query: str,
    scope: AccessScope,
    *,
    limit: int = 5,
    project_id: str | None = None,
  ) -> dict:
    hits, retrieval = self._retrieve(query, scope, limit=limit, project_id=project_id)
    return {
      "query": query,
      "answer": None,
      "citations": [self._citation(hit) for hit in hits],
      "retrieval": retrieval,
    }

  def _retrieve(
    self,
    query: str,
    scope: AccessScope,
    *,
    limit: int,
    project_id: str | None = None,
  ) -> tuple[list, RetrievalSummary]:
    hits = self.retriever.retrieve(
      RetrievalQuery(
        text=query,
        scope=scope,
        project_id=project_id,
        limit=limit,
        score_threshold=self.score_threshold,
      )
    )
    return (
      hits,
      RetrievalSummary(
        hit_count=len(hits),
        top_score=hits[0].score if hits else None,
        embedding_version=hits[0].embedding_version if hits else None,
      ),
    )

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
