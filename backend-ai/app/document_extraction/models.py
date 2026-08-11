from __future__ import annotations

from enum import Enum
from hashlib import sha256
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, model_validator


SHA256_PATTERN = r"^[a-f0-9]{64}$"


class StrictModel(BaseModel):
  model_config = ConfigDict(extra="forbid")


class ExtractionLimits(StrictModel):
  maximum_document_bytes: int = Field(..., gt=0)
  maximum_document_pages: int = Field(..., gt=0)
  maximum_wall_seconds: float = Field(..., gt=0)
  maximum_peak_memory_bytes: int = Field(..., gt=0)


class SecretScanResult(StrictModel):
  completed: bool
  secret_detected: bool
  finding_types: list[str] = Field(default_factory=list, max_length=50)


class PromptInjectionSignal(StrictModel):
  completed: bool
  detected: bool
  categories: list[str] = Field(default_factory=list, max_length=50)


class DocumentInspection(StrictModel):
  media_type: str = Field(..., min_length=1, max_length=200)
  page_count: int = Field(..., ge=0)
  encrypted: bool
  archive: bool
  embedded_executable: bool
  malformed: bool
  estimated_wall_seconds: float = Field(..., ge=0)
  estimated_peak_memory_bytes: int = Field(..., ge=0)
  secret_scan: SecretScanResult
  prompt_injection: PromptInjectionSignal


class OCRApproval(StrictModel):
  approval_id: str = Field(..., min_length=1, max_length=128)
  approver_id: str = Field(..., min_length=1, max_length=128)
  content_sha256: str = Field(..., pattern=SHA256_PATTERN)
  languages: list[str] = Field(..., min_length=1, max_length=2)
  policy_version: str = Field(..., min_length=1, max_length=128)

  @model_validator(mode="after")
  def validate_unique_languages(self):
    if len(set(self.languages)) != len(self.languages):
      raise ValueError("OCR approval languages must be unique")
    return self


class OCRRequest(StrictModel):
  languages: list[str] = Field(..., min_length=1, max_length=2)
  approval: OCRApproval | None = None

  @model_validator(mode="after")
  def validate_unique_languages(self):
    if len(set(self.languages)) != len(self.languages):
      raise ValueError("OCR request languages must be unique")
    return self


class ExtractionRequest(StrictModel):
  source: str = Field(..., min_length=1, max_length=4096)
  inspection: DocumentInspection
  ocr: OCRRequest | None = None


class ExtractionSecurityMetadata(StrictModel):
  prompt_injection_detected: bool = False
  prompt_injection_categories: list[str] = Field(default_factory=list, max_length=50)


class ApprovedExtractionRequest(StrictModel):
  path: Path
  source_uri: str = Field(..., min_length=1, max_length=4096)
  media_type: str
  source_checksum: str = Field(..., pattern=SHA256_PATTERN)
  size_bytes: int = Field(..., ge=0)
  page_count: int = Field(..., ge=0)
  manifest_version: str
  limits: ExtractionLimits
  minimum_primary_text_characters: int = Field(..., gt=0)
  ocr: OCRRequest | None = None
  security: ExtractionSecurityMetadata = ExtractionSecurityMetadata()


class BoundingBox(StrictModel):
  left: float = Field(..., ge=0)
  top: float = Field(..., ge=0)
  right: float = Field(..., ge=0)
  bottom: float = Field(..., ge=0)

  @model_validator(mode="after")
  def validate_coordinates(self):
    if self.right < self.left or self.bottom < self.top:
      raise ValueError("bounding box coordinates are inverted")
    return self


class SourceSpan(StrictModel):
  page_number: int | None = Field(default=None, ge=1)
  start_offset: int = Field(..., ge=0)
  end_offset: int = Field(..., ge=0)
  bounding_box: BoundingBox | None = None

  @model_validator(mode="after")
  def validate_offsets(self):
    if self.end_offset < self.start_offset:
      raise ValueError("source span end precedes start")
    if self.bounding_box is not None and self.page_number is None:
      raise ValueError("a bounding box requires a page number")
    return self


class TableData(StrictModel):
  headers: list[str] = Field(default_factory=list)
  rows: list[list[str]] = Field(default_factory=list)

  @model_validator(mode="after")
  def validate_shape(self):
    widths = {len(row) for row in self.rows}
    if len(widths) > 1:
      raise ValueError("table rows must have a consistent width")
    if self.headers and widths and len(self.headers) not in widths:
      raise ValueError("table headers and rows must have the same width")
    return self


class ElementKind(str, Enum):
  HEADING = "heading"
  PARAGRAPH = "paragraph"
  LIST_ITEM = "list_item"
  TABLE = "table"
  CODE = "code"


class ExtractionElement(StrictModel):
  element_id: str = Field(..., min_length=1, max_length=256)
  kind: ElementKind
  text: str
  checksum: str = Field(..., pattern=SHA256_PATTERN)
  source_spans: list[SourceSpan] = Field(..., min_length=1)
  heading_level: int | None = Field(default=None, ge=1, le=6)
  list_level: int | None = Field(default=None, ge=0, le=100)
  list_marker: str | None = Field(default=None, max_length=20)
  table: TableData | None = None

  @model_validator(mode="after")
  def validate_structure_and_checksum(self):
    expected_checksum = sha256(self.text.encode("utf-8")).hexdigest()
    if self.checksum != expected_checksum:
      raise ValueError("element checksum does not match normalized text")
    if self.kind is ElementKind.HEADING and self.heading_level is None:
      raise ValueError("heading elements require heading_level")
    if self.kind is ElementKind.LIST_ITEM and self.list_level is None:
      raise ValueError("list elements require list_level")
    if self.kind is ElementKind.TABLE and self.table is None:
      raise ValueError("table elements require table data")
    if self.kind is not ElementKind.TABLE and self.table is not None:
      raise ValueError("table data is only valid for table elements")
    return self


class OCRProvenance(StrictModel):
  requested: bool
  performed: bool
  languages: list[str] = Field(default_factory=list, max_length=2)
  engine_name: str | None = Field(default=None, max_length=128)
  engine_version: str | None = Field(default=None, max_length=128)
  human_approval_id: str | None = Field(default=None, max_length=128)

  @model_validator(mode="after")
  def validate_performed_ocr(self):
    if self.performed and not self.requested:
      raise ValueError("performed OCR must have been requested")
    if self.performed and (
      not self.languages
      or not self.engine_name
      or not self.engine_version
      or not self.human_approval_id
    ):
      raise ValueError("performed OCR requires languages, engine and human approval provenance")
    return self


class ExtractionProvenance(StrictModel):
  extractor_name: str = Field(..., min_length=1, max_length=128)
  extractor_version: str = Field(..., min_length=1, max_length=128)
  extraction_contract_version: str = Field(..., min_length=1, max_length=128)
  fallback_reason: str | None = Field(default=None, max_length=128)
  ocr: OCRProvenance


class ExtractionMetadata(StrictModel):
  prompt_injection_detected: bool = False
  prompt_injection_categories: list[str] = Field(default_factory=list, max_length=50)
  warnings: list[str] = Field(default_factory=list, max_length=100)


class ExtractedDocument(StrictModel):
  source_uri: str = Field(..., min_length=1, max_length=4096)
  source_checksum: str = Field(..., pattern=SHA256_PATTERN)
  extraction_checksum: str = Field(..., pattern=SHA256_PATTERN)
  media_type: str = Field(..., min_length=1, max_length=200)
  elements: list[ExtractionElement]
  provenance: ExtractionProvenance
  metadata: ExtractionMetadata = ExtractionMetadata()
