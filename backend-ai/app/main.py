"""Compatibility exports for the modular FastAPI HTTP boundary."""

from .http.factory import create_app
from .http.schemas import (
  AnalyzeRequest,
  BatchRequest,
  ClassifyRequest,
  InternalExtractionJobRequest,
  InternalJobRequest,
  KnowledgeAnswerApiRequest,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
  OCRAcceptedTask,
  OCRFeedbackRequest,
  ProviderStateRequest,
  RagAnalyzeRequest,
  StrictRequest,
)


__all__ = [
  "AnalyzeRequest",
  "BatchRequest",
  "ClassifyRequest",
  "InternalExtractionJobRequest",
  "InternalJobRequest",
  "KnowledgeAnswerApiRequest",
  "KnowledgeSearchRequest",
  "KnowledgeSearchResponse",
  "OCRAcceptedTask",
  "OCRFeedbackRequest",
  "ProviderStateRequest",
  "RagAnalyzeRequest",
  "StrictRequest",
  "create_app",
]
