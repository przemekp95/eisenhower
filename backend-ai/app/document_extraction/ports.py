from __future__ import annotations

from pathlib import Path
from typing import Protocol

from .models import (
  ApprovedExtractionRequest,
  DocumentInspection,
  ExtractedDocument,
  ExtractionRequest,
  PromptInjectionSignal,
  SecretScanResult,
)


class DocumentExtractor(Protocol):
  def extract(self, request: ApprovedExtractionRequest) -> ExtractedDocument: ...


class DocumentInspector(Protocol):
  def inspect(self, path: Path) -> DocumentInspection: ...


class SecretDetector(Protocol):
  def scan(self, path: Path) -> SecretScanResult: ...


class PromptInjectionDetector(Protocol):
  def inspect(self, document: ExtractedDocument) -> PromptInjectionSignal: ...


class ExtractionPreflight(Protocol):
  def authorize(self, request: ExtractionRequest) -> ApprovedExtractionRequest: ...
