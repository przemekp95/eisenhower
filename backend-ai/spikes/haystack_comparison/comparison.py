from __future__ import annotations

from haystack import Pipeline, component

from app.rag.application import RagAnalysisService
from app.rag.models import AccessScope, AnalyzeResult, RetrievalHit, RetrievalQuery


@component
class _RetrieveComponent:
  def __init__(self, retriever, *, limit: int, score_threshold: float):
    self.retriever = retriever
    self.limit = limit
    self.score_threshold = score_threshold

  @component.output_types(hits=list[RetrievalHit])
  def run(self, task: str, scope: AccessScope):
    return {
      "hits": self.retriever.retrieve(
        RetrievalQuery(
          text=task,
          scope=scope,
          limit=self.limit,
          score_threshold=self.score_threshold,
        )
      )
    }


class _StaticRetriever:
  def __init__(self, hits: list[RetrievalHit]):
    self.hits = hits

  def retrieve(self, query: RetrievalQuery) -> list[RetrievalHit]:
    return self.hits


@component
class _AnalyzeComponent:
  def __init__(self, generator, fallback_classifier, *, limit: int, score_threshold: float):
    self.generator = generator
    self.fallback_classifier = fallback_classifier
    self.limit = limit
    self.score_threshold = score_threshold

  @component.output_types(result=AnalyzeResult)
  def run(self, task: str, scope: AccessScope, hits: list[RetrievalHit]):
    service = RagAnalysisService(
      _StaticRetriever(hits),
      self.generator,
      self.fallback_classifier,
      retrieval_limit=self.limit,
      score_threshold=self.score_threshold,
    )
    return {"result": service.analyze(task, scope)}


class HaystackAnalysisAdapter:
  """Research adapter proving that Haystack types can stay behind our ports."""

  def __init__(
    self,
    retriever,
    generator,
    fallback_classifier,
    *,
    retrieval_limit: int = 6,
    score_threshold: float = 0.2,
  ):
    pipeline = Pipeline()
    pipeline.add_component(
      "retrieve",
      _RetrieveComponent(
        retriever,
        limit=retrieval_limit,
        score_threshold=score_threshold,
      ),
    )
    pipeline.add_component(
      "analyze",
      _AnalyzeComponent(
        generator,
        fallback_classifier,
        limit=retrieval_limit,
        score_threshold=score_threshold,
      ),
    )
    pipeline.connect("retrieve.hits", "analyze.hits")
    self.pipeline = pipeline

  def analyze(self, task: str, scope: AccessScope) -> AnalyzeResult:
    output = self.pipeline.run(
      {
        "retrieve": {"task": task, "scope": scope},
        "analyze": {"task": task, "scope": scope},
      }
    )
    result = output["analyze"]["result"]
    return AnalyzeResult.model_validate(result)
