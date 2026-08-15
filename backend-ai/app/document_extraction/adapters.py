from __future__ import annotations

from enum import Enum
from hashlib import sha256
from importlib.metadata import version
import json
import os
from pathlib import Path
from resource import RUSAGE_SELF, getrusage
from time import monotonic
from typing import Mapping

from .artifacts import ArtifactBundleRejected, verify_artifact_bundle

from .models import (
  ApprovedExtractionRequest,
  ElementKind,
  ExtractedDocument,
  ExtractionElement,
  ExtractionMetadata,
  ExtractionProvenance,
  OCRProvenance,
  SourceSpan,
  TableData,
)


CONTRACT_VERSION = "document-extraction-v1"
DOCLING_LAYOUT_MODEL_REPOSITORY = "docling-project/docling-layout-heron-onnx"
DOCLING_LAYOUT_MODEL_REVISION = "40bde044036bb181c130ddf6c51792187268748f"
TESSERACT_CLI_VERSION = "5.3.4"


def resolve_docling_artifacts(
  environment: Mapping[str, str] | None = None,
) -> Path | None:
  source = environment if environment is not None else os.environ
  raw_path = source.get("DOCLING_ARTIFACTS_PATH", "").strip()
  digest = source.get("DOCLING_ARTIFACTS_MANIFEST_SHA256", "").strip()
  if not raw_path and not digest:
    if source.get("APP_ENV") == "production":
      raise ArtifactBundleRejected("verified Docling artifacts are required in production")
    return None
  if not raw_path or not digest:
    raise ArtifactBundleRejected("Docling artifact path and manifest digest are both required")
  return verify_artifact_bundle(
    Path(raw_path),
    expected_manifest_sha256=digest,
    expected_repository=DOCLING_LAYOUT_MODEL_REPOSITORY,
    expected_revision=DOCLING_LAYOUT_MODEL_REVISION,
  )


class FallbackReason(str, Enum):
  PRIMARY_UNSUPPORTED_LAYOUT = "PRIMARY_UNSUPPORTED_LAYOUT"
  PRIMARY_QUALITY_BELOW_APPROVED_THRESHOLD = "PRIMARY_QUALITY_BELOW_APPROVED_THRESHOLD"


class PrimaryFallbackEligible(RuntimeError):
  def __init__(self, reason: FallbackReason):
    self.reason = reason
    super().__init__(reason.value)


class ExtractionRuntimeRejected(RuntimeError):
  """Extraction failed or exceeded its frozen runtime contract without fallback."""


class GovernedDocumentExtractor:
  def __init__(self, primary, fallback):
    self.primary = primary
    self.fallback = fallback

  def extract(self, request: ApprovedExtractionRequest) -> ExtractedDocument:
    try:
      return self.primary.extract(request)
    except PrimaryFallbackEligible as error:
      result = self.fallback.extract(request)
      provenance = result.provenance.model_copy(update={"fallback_reason": error.reason.value})
      return result.model_copy(update={"provenance": provenance})


class DoclingDocumentExtractor:
  def __init__(self, converter_factory=None):
    self.converter_factory = converter_factory or _docling_converter

  def extract(self, request: ApprovedExtractionRequest) -> ExtractedDocument:
    converter = self.converter_factory(request)
    started = monotonic()
    try:
      result = converter.convert(
        request.path,
        max_file_size=request.limits.maximum_document_bytes,
        max_num_pages=request.limits.maximum_document_pages,
      )
    except PrimaryFallbackEligible:
      raise
    except (MemoryError, TimeoutError) as error:
      raise ExtractionRuntimeRejected("primary parser exceeded its resource budget") from error
    except Exception as error:
      raise ExtractionRuntimeRejected("primary parser failed closed") from error
    _enforce_runtime_budget(started, request)
    elements = _docling_elements(result.document)
    if sum(len(element.text.strip()) for element in elements) < request.minimum_primary_text_characters:
      raise PrimaryFallbackEligible(FallbackReason.PRIMARY_QUALITY_BELOW_APPROVED_THRESHOLD)
    return _document(
      request,
      elements,
      extractor_name="docling",
      extractor_version=version("docling"),
      ocr_engine="tesseract-cli" if request.ocr else None,
    )


class UnstructuredDocumentExtractor:
  def __init__(self, partition_function=None):
    self.partition_function = partition_function or _unstructured_partition

  def extract(self, request: ApprovedExtractionRequest) -> ExtractedDocument:
    started = monotonic()
    try:
      raw_elements = self.partition_function(
        filename=str(request.path),
        content_type=request.media_type,
        strategy="fast",
        pdf_infer_table_structure=False,
      )
    except (MemoryError, TimeoutError) as error:
      raise ExtractionRuntimeRejected("fallback parser exceeded its resource budget") from error
    except Exception as error:
      raise ExtractionRuntimeRejected("fallback parser failed closed") from error
    _enforce_runtime_budget(started, request)
    elements = _unstructured_elements(raw_elements)
    if not elements:
      raise ExtractionRuntimeRejected("fallback parser produced no approved content")
    return _document(
      request,
      elements,
      extractor_name="unstructured",
      extractor_version=version("unstructured"),
      ocr_engine=None,
    )


def _docling_converter(request: ApprovedExtractionRequest):
  from docling.datamodel.base_models import InputFormat
  from docling.datamodel.object_detection_engine_options import (
    OnnxRuntimeObjectDetectionEngineOptions,
  )
  from docling.datamodel.pipeline_options import (
    LayoutObjectDetectionOptions,
    PdfPipelineOptions,
    TesseractCliOcrOptions,
  )
  from docling.document_converter import DocumentConverter, PdfFormatOption
  from docling.models.inference_engines.object_detection.base import ObjectDetectionEngineType

  formats = [InputFormat.PDF, InputFormat.DOCX, InputFormat.PPTX, InputFormat.HTML]
  languages = [{"pl": "pol", "en": "eng"}[item] for item in request.ocr.languages] if request.ocr else ["pol", "eng"]
  layout_options = LayoutObjectDetectionOptions.from_preset(
    "layout_heron_default",
    engine_options=OnnxRuntimeObjectDetectionEngineOptions(),
  )
  model_spec = getattr(layout_options, "model_spec")
  engine_overrides = getattr(model_spec, "engine_overrides")
  onnx_override = engine_overrides[ObjectDetectionEngineType.ONNXRUNTIME]
  model_spec = model_spec.model_copy(update={
    "engine_overrides": {
      **engine_overrides,
      ObjectDetectionEngineType.ONNXRUNTIME: onnx_override.model_copy(
        update={"revision": DOCLING_LAYOUT_MODEL_REVISION}
      ),
    }
  })
  layout_options = layout_options.model_copy(update={"model_spec": model_spec})
  pdf_options = PdfPipelineOptions(
    artifacts_path=resolve_docling_artifacts(),
    document_timeout=request.limits.maximum_wall_seconds,
    enable_remote_services=False,
    allow_external_plugins=False,
    do_ocr=request.ocr is not None,
    ocr_options=TesseractCliOcrOptions(lang=languages, tesseract_cmd="tesseract"),
    layout_options=layout_options,
  )
  return DocumentConverter(
    allowed_formats=formats,
    format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_options)},
  )


def _unstructured_partition(**kwargs):
  from unstructured.partition.auto import partition

  return partition(**kwargs)


def _docling_elements(document) -> list[ExtractionElement]:
  elements = []
  offset = 0
  for item, depth in document.iterate_items():
    label = str(getattr(item, "label", "text"))
    text = _item_text(item, document)
    if not text.strip():
      continue
    kind = _kind(label)
    table = _docling_table(item, document) if kind is ElementKind.TABLE else None
    elements.append(_element(text, kind, len(elements), offset, depth, table=table))
    offset += len(text) + 1
  return elements


def _unstructured_elements(raw_elements) -> list[ExtractionElement]:
  elements = []
  offset = 0
  for raw in raw_elements:
    text = str(raw).strip()
    if not text:
      continue
    category = str(getattr(raw, "category", raw.__class__.__name__)).lower()
    kind = _kind(category)
    table = TableData(rows=[[text]]) if kind is ElementKind.TABLE else None
    page_number = getattr(getattr(raw, "metadata", None), "page_number", None)
    elements.append(
      _element(text, kind, len(elements), offset, 1, table=table, page_number=page_number)
    )
    offset += len(text) + 1
  return elements


def _item_text(item, document) -> str:
  if hasattr(item, "text"):
    return str(item.text)
  if hasattr(item, "export_to_dataframe"):
    return item.export_to_dataframe(doc=document).to_markdown(index=False)
  return ""


def _docling_table(item, document) -> TableData:
  frame = item.export_to_dataframe(doc=document)
  return TableData(
    headers=[str(column) for column in frame.columns],
    rows=[[str(value) for value in row] for row in frame.itertuples(index=False, name=None)],
  )


def _kind(label: str) -> ElementKind:
  normalized = label.lower()
  if any(value in normalized for value in ("title", "heading", "section_header")):
    return ElementKind.HEADING
  if "list" in normalized:
    return ElementKind.LIST_ITEM
  if "table" in normalized:
    return ElementKind.TABLE
  if "code" in normalized:
    return ElementKind.CODE
  return ElementKind.PARAGRAPH


def _element(
  text: str,
  kind: ElementKind,
  index: int,
  offset: int,
  depth: int,
  *,
  table: TableData | None,
  page_number: int | None = None,
) -> ExtractionElement:
  checksum = sha256(text.encode("utf-8")).hexdigest()
  return ExtractionElement(
    element_id=f"element-{index}-{checksum[:12]}",
    kind=kind,
    text=text,
    checksum=checksum,
    source_spans=[SourceSpan(
      page_number=page_number,
      start_offset=offset,
      end_offset=offset + len(text),
    )],
    heading_level=min(max(depth, 1), 6) if kind is ElementKind.HEADING else None,
    list_level=max(depth - 1, 0) if kind is ElementKind.LIST_ITEM else None,
    list_marker="-" if kind is ElementKind.LIST_ITEM else None,
    table=table,
  )


def _document(
  request: ApprovedExtractionRequest,
  elements: list[ExtractionElement],
  *,
  extractor_name: str,
  extractor_version: str,
  ocr_engine: str | None,
) -> ExtractedDocument:
  serialized = json.dumps(
    [element.model_dump(mode="json") for element in elements],
    sort_keys=True,
    separators=(",", ":"),
    ensure_ascii=False,
  )
  approval = request.ocr.approval if request.ocr else None
  return ExtractedDocument(
    source_uri=request.source_uri,
    source_checksum=request.source_checksum,
    extraction_checksum=sha256(serialized.encode("utf-8")).hexdigest(),
    media_type=request.media_type,
    elements=elements,
    provenance=ExtractionProvenance(
      extractor_name=extractor_name,
      extractor_version=extractor_version,
      extraction_contract_version=CONTRACT_VERSION,
      ocr=OCRProvenance(
        requested=request.ocr is not None,
        performed=request.ocr is not None and ocr_engine is not None,
        languages=request.ocr.languages if request.ocr else [],
        engine_name=ocr_engine,
        engine_version=TESSERACT_CLI_VERSION if ocr_engine else None,
        human_approval_id=approval.approval_id if approval and ocr_engine else None,
      ),
    ),
    metadata=ExtractionMetadata(
      prompt_injection_detected=request.security.prompt_injection_detected,
      prompt_injection_categories=request.security.prompt_injection_categories,
    ),
  )


def _enforce_runtime_budget(started: float, request: ApprovedExtractionRequest) -> None:
  if monotonic() - started > request.limits.maximum_wall_seconds:
    raise ExtractionRuntimeRejected("parser exceeded maximum_wall_seconds")
  if getrusage(RUSAGE_SELF).ru_maxrss * 1024 > request.limits.maximum_peak_memory_bytes:
    raise ExtractionRuntimeRejected("parser exceeded maximum_peak_memory_bytes")
