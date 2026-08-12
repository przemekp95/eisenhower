from __future__ import annotations

from .models import (
  AccessScope,
  AnalyzeResult,
  Citation,
  GenerationMetadata,
  GenerationRequest,
  KnowledgeAnswerRequest,
  KnowledgeAnswerResponse,
  RetrievalQuery,
  RetrievalSummary,
)
from ..generation.delta import InformationDeltaValidator, InformationDeltaViolation
from ..generation.models import InformationDelta, KnownStatement
from .errors import GenerationProviderError, InvalidGenerationOutput, RerankerUnavailable
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
    delta_validator: InformationDeltaValidator | None = None,
  ):
    self.retriever = retriever
    self.generator = generator
    self.fallback_classifier = fallback_classifier
    self.retrieval_limit = retrieval_limit
    self.score_threshold = score_threshold
    self.retrieval_version = retrieval_version
    self.index_version = index_version
    self.delta_validator = delta_validator

  @property
  def generation_enabled(self) -> bool:
    return self.generator is not None

  def analyze(
    self,
    task: str,
    scope: AccessScope,
    *,
    language: str = "en",
    known_state: list[KnownStatement] | None = None,
    previous_output_statements: list[KnownStatement] | None = None,
    freshness_requirement: str = "snapshot_sufficient",
  ) -> AnalyzeResult:
    try:
      hits, retrieval = self._retrieve(task, scope, limit=self.retrieval_limit)
    except RerankerUnavailable:
      return self._fallback(task, RetrievalSummary(), "reranker_unavailable")
    if freshness_requirement == "current_world_required":
      delta = InformationDelta(
        status="freshness_unverified",
        claims=[],
        summary_code="current_world_freshness_unverified",
      )
      return AnalyzeResult(
        mode="no_answer",
        explanation=self._delta_explanation(delta.status, language),
        citations=[],
        retrieval=retrieval,
        fallback_reason="current_world_freshness_unverified",
        information_delta=delta,
      )
    if not hits:
      return self._fallback(task, retrieval, "no_retrieval_hits")
    if self.generator is None:
      return self._fallback(task, retrieval, "generation_disabled")

    try:
      generation_request = GenerationRequest(
        task=task,
        context=hits,
        language=language,
        retrieval_version=self.retrieval_version,
        index_version=self.index_version,
        known_state=known_state,
        previous_output_statements=previous_output_statements,
        freshness_requirement=freshness_requirement,
      )
      generated = self.generator.generate(generation_request)
    except InvalidGenerationOutput as error:
      return self._fallback(task, retrieval, error.reason)
    except GenerationProviderError as error:
      return self._fallback(task, retrieval, error.reason)

    output = generated.output
    if generation_request.delta_requested or output.information_delta is not None:
      if self.delta_validator is None:
        return self._fallback(task, retrieval, "invalid_information_delta")
      try:
        self.delta_validator.validate(generation_request, output)
      except InformationDeltaViolation:
        return self._fallback(task, retrieval, "invalid_information_delta")
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
      explanation = output.explanation
      if output.information_delta is not None:
        explanation = self._delta_explanation(output.information_delta.status, language)
      return AnalyzeResult(
        mode="no_answer",
        explanation=explanation,
        citations=[],
        retrieval=retrieval,
        generation=generation,
        fallback_reason=output.no_answer_reason,
        information_delta=output.information_delta,
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
    explanation = output.explanation
    if output.information_delta is not None:
      explanation = self._delta_explanation(output.information_delta.status, language)
    return AnalyzeResult(
      mode="rag",
      quadrant=output.quadrant,
      quadrant_name=QUADRANT_NAMES[output.quadrant],
      confidence=output.confidence,
      explanation=explanation,
      citations=citations,
      retrieval=retrieval,
      generation=generation,
      information_delta=output.information_delta,
    )

  def retrieve_summary(self, query: str, scope: AccessScope) -> RetrievalSummary:
    _, summary = self._retrieve(query, scope, limit=self.retrieval_limit)
    return summary

  def generation_status(self) -> dict[str, object]:
    if self.generator is None:
      return {"enabled": False, "state": "disabled", "failures": 0}
    status_getter = getattr(self.generator, "status", None)
    status = status_getter() if callable(status_getter) else {"state": "unknown"}
    return {"enabled": True, **status}

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

  def answer(
    self,
    query: str,
    scope: AccessScope,
    *,
    language: str = "en",
    limit: int = 5,
    project_id: str | None = None,
  ) -> KnowledgeAnswerResponse:
    try:
      hits, retrieval = self._retrieve(query, scope, limit=limit, project_id=project_id)
    except RerankerUnavailable:
      return self._knowledge_no_answer(RetrievalSummary(), "reranker_unavailable")
    if not hits:
      return self._knowledge_no_answer(retrieval, "no_retrieval_hits")
    if self.generator is None:
      return self._knowledge_no_answer(retrieval, "generation_disabled")

    try:
      generated = self.generator.answer(KnowledgeAnswerRequest(
        task=query,
        context=hits,
        language=language,
        retrieval_version=self.retrieval_version,
        index_version=self.index_version,
      ))
    except InvalidGenerationOutput as error:
      return self._knowledge_no_answer(retrieval, error.reason)
    except GenerationProviderError as error:
      return self._knowledge_no_answer(retrieval, error.reason)

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
      return self._knowledge_no_answer(
        retrieval,
        output.no_answer_reason or "insufficient_context",
        generation=generation,
      )

    hit_by_id = {hit.chunk_id: hit for hit in hits}
    claim_citations = {
      citation_id for claim in output.claims for citation_id in claim.citation_ids
    }
    if (
      not output.answer
      or not output.claims
      or not output.citations
      or claim_citations != set(output.citations)
      or any(citation_id not in hit_by_id for citation_id in output.citations)
    ):
      return self._knowledge_no_answer(retrieval, "invalid_citations")
    return KnowledgeAnswerResponse(
      status="answered",
      answer=output.answer,
      claims=output.claims,
      citations=[self._citation(hit_by_id[citation_id]) for citation_id in output.citations],
      retrieval=retrieval,
      generation=generation,
    )

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

  @staticmethod
  def _knowledge_no_answer(
    retrieval: RetrievalSummary,
    reason: str,
    *,
    generation: GenerationMetadata | None = None,
  ) -> KnowledgeAnswerResponse:
    return KnowledgeAnswerResponse(
      status="insufficient_evidence",
      answer=None,
      claims=[],
      citations=[],
      retrieval=retrieval,
      generation=generation,
      no_answer_reason=reason,
    )

  @staticmethod
  def _delta_explanation(status: str, language: str) -> str:
    messages = {
      "pl": {
        "new_information": "Dostępny jest ugruntowany przyrost informacji.",
        "mixed": "Dostępny jest ugruntowany przyrost wraz z odniesieniem do znanego stanu.",
        "confirmation_only": "Źródła potwierdzają wyłącznie znane informacje.",
        "no_new_information": "Brak nowej ugruntowanej informacji względem przekazanego stanu.",
        "freshness_unverified": "Zamrożony korpus nie potwierdza aktualnego stanu świata.",
      },
      "en": {
        "new_information": "A grounded information delta is available.",
        "mixed": "A grounded delta is available alongside known-state references.",
        "confirmation_only": "The sources only confirm supplied known information.",
        "no_new_information": "No new grounded information exists relative to the supplied state.",
        "freshness_unverified": "The frozen corpus cannot verify the current state of the world.",
      },
    }
    return messages[language][status]
