from __future__ import annotations

from collections import OrderedDict
from enum import Enum
from hashlib import sha256
from importlib.metadata import version
import json
from multiprocessing import get_context
from multiprocessing.connection import Connection
import os
from os import sysconf
from pathlib import Path
from resource import RUSAGE_SELF, getrusage
from time import monotonic
from typing import Callable, Mapping

from .artifacts import ArtifactBundleRejected, verify_artifact_bundle

from .models import (
  ApprovedExtractionRequest,
  BoundingBox,
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
DOCLING_TABLE_MODEL_REPOSITORY = "docling-project/docling-models"
DOCLING_TABLE_MODEL_REVISION = "fc0f2d45e2218ea24bce5045f58a389aed16dc23"
TESSERACT_CLI_VERSION = "5.5.2"


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
    expected_repositories={
      DOCLING_LAYOUT_MODEL_REPOSITORY: DOCLING_LAYOUT_MODEL_REVISION,
      DOCLING_TABLE_MODEL_REPOSITORY: DOCLING_TABLE_MODEL_REVISION,
    },
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


_SAFE_RUNTIME_REJECTIONS = frozenset({
  "fallback_parser_failed_closed",
  "fallback_parser_resource_budget_exceeded",
  "fallback_quality_below_approved_threshold",
  "parser_memory_limit_exceeded",
  "parser_process_failed_closed",
  "parser_wall_time_exceeded",
  "primary_parser_failed_closed",
  "primary_parser_resource_budget_exceeded",
})


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


def build_governed_document_extractor() -> GovernedDocumentExtractor:
  """Construct the frozen local parser chain inside the isolated process."""
  return GovernedDocumentExtractor(
    DoclingDocumentExtractor(),
    UnstructuredDocumentExtractor(),
  )


class DoclingDocumentExtractor:
  def __init__(self, converter_factory=None):
    self.converter_factory = converter_factory or _docling_converter
    self._converters = OrderedDict()

  def extract(self, request: ApprovedExtractionRequest) -> ExtractedDocument:
    converter = self._converter(request)
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
      raise ExtractionRuntimeRejected("primary_parser_resource_budget_exceeded") from error
    except Exception as error:
      if error.__class__.__name__ in {
        "UnsupportedDocumentFormatError",
        "UnsupportedFormatError",
      }:
        raise PrimaryFallbackEligible(FallbackReason.PRIMARY_UNSUPPORTED_LAYOUT) from error
      raise ExtractionRuntimeRejected("primary_parser_failed_closed") from error
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

  def _converter(self, request: ApprovedExtractionRequest):
    key = (
      request.limits.maximum_wall_seconds,
      tuple(request.ocr.languages) if request.ocr else (),
    )
    converter = self._converters.get(key)
    if converter is not None:
      self._converters.move_to_end(key)
      return converter
    converter = self.converter_factory(request)
    self._converters[key] = converter
    while len(self._converters) > 4:
      self._converters.popitem(last=False)
    return converter


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
      raise ExtractionRuntimeRejected("fallback_parser_resource_budget_exceeded") from error
    except Exception as error:
      raise ExtractionRuntimeRejected("fallback_parser_failed_closed") from error
    _enforce_runtime_budget(started, request)
    elements = _unstructured_elements(raw_elements)
    fallback_minimum = min(request.minimum_primary_text_characters, 20)
    if sum(len(element.text.strip()) for element in elements) < fallback_minimum:
      raise ExtractionRuntimeRejected("fallback_quality_below_approved_threshold")
    return _document(
      request,
      elements,
      extractor_name="unstructured",
      extractor_version=version("unstructured"),
      ocr_engine=None,
    )


class IsolatedDocumentExtractor:
  """Run the parser in a reusable, memory-capped spawned child process."""

  def __init__(self, extractor_factory: Callable[[], object]):
    self._extractor_factory = extractor_factory
    self._process = None
    self._connection: Connection | None = None
    self._memory_limit: int | None = None

  @property
  def child_pid(self) -> int | None:
    if self._process is None or not self._process.is_alive():
      return None
    return self._process.pid

  def extract(self, request: ApprovedExtractionRequest) -> ExtractedDocument:
    started = monotonic()
    self._ensure_child(request.limits.maximum_peak_memory_bytes)
    remaining = request.limits.maximum_wall_seconds - (monotonic() - started)
    if remaining <= 0 or self._connection is None:
      self._stop_child()
      raise ExtractionRuntimeRejected("parser_wall_time_exceeded")
    try:
      self._connection.send(request.model_dump(mode="python"))
      deadline = monotonic() + remaining
      while True:
        remaining = deadline - monotonic()
        if remaining <= 0:
          self._stop_child()
          raise ExtractionRuntimeRejected("parser_wall_time_exceeded")
        if self._connection.poll(min(0.05, remaining)):
          status, payload = self._connection.recv()
          break
        if self.child_pid is None:
          self._stop_child()
          raise ExtractionRuntimeRejected("parser_process_failed_closed")
        if _resident_set_bytes(self.child_pid) > request.limits.maximum_peak_memory_bytes:
          self._stop_child()
          raise ExtractionRuntimeRejected("parser_memory_limit_exceeded")
    except (EOFError, BrokenPipeError, OSError) as error:
      self._stop_child()
      raise ExtractionRuntimeRejected("parser_process_failed_closed") from error
    if status == "ok":
      peak_rss = int(payload["peak_rss_bytes"])
      if peak_rss > request.limits.maximum_peak_memory_bytes:
        self._stop_child()
        raise ExtractionRuntimeRejected("parser_memory_limit_exceeded")
      return ExtractedDocument.model_validate(payload["document"])
    if status == "memory":
      self._stop_child()
      raise ExtractionRuntimeRejected("parser_memory_limit_exceeded")
    if status == "runtime" and payload in _SAFE_RUNTIME_REJECTIONS:
      if payload in {
        "fallback_parser_resource_budget_exceeded",
        "parser_memory_limit_exceeded",
        "primary_parser_resource_budget_exceeded",
      }:
        self._stop_child()
      raise ExtractionRuntimeRejected(payload)
    raise ExtractionRuntimeRejected("primary_parser_failed_closed")

  def close(self) -> None:
    if self._connection is not None and self.child_pid is not None:
      try:
        self._connection.send(None)
      except (BrokenPipeError, OSError):
        pass
    self._stop_child()

  def _ensure_child(self, memory_limit: int) -> None:
    if self.child_pid is not None and self._memory_limit == memory_limit:
      return
    self._stop_child()
    context = get_context("spawn")
    parent, child = context.Pipe()
    process = context.Process(
      target=_isolated_extraction_worker,
      args=(child, self._extractor_factory),
      daemon=True,
    )
    process.start()
    child.close()
    self._process = process
    self._connection = parent
    self._memory_limit = memory_limit

  def _stop_child(self) -> None:
    connection, process = self._connection, self._process
    self._connection = None
    self._process = None
    self._memory_limit = None
    if connection is not None:
      connection.close()
    if process is not None:
      if process.is_alive():
        process.terminate()
      process.join(timeout=2)
      if process.is_alive():
        process.kill()
        process.join(timeout=2)

  def __del__(self):
    self.close()


def _isolated_extraction_worker(
  connection: Connection,
  extractor_factory: Callable[[], object],
) -> None:
  try:
    extractor = extractor_factory()
    while True:
      payload = connection.recv()
      if payload is None:
        return
      try:
        request = ApprovedExtractionRequest.model_validate(payload)
        result = extractor.extract(request)
        connection.send(("ok", {
          "document": result.model_dump(mode="json"),
          "peak_rss_bytes": getrusage(RUSAGE_SELF).ru_maxrss * 1024,
        }))
      except MemoryError:
        connection.send(("memory", None))
      except ExtractionRuntimeRejected as error:
        rejection = str(error)
        connection.send((
          "runtime",
          rejection if rejection in _SAFE_RUNTIME_REJECTIONS else "primary_parser_failed_closed",
        ))
      except Exception:
        connection.send(("runtime", "primary_parser_failed_closed"))
  except MemoryError:
    try:
      connection.send(("memory", None))
    except Exception:
      pass
  finally:
    connection.close()


def _resident_set_bytes(pid: int) -> int:
  try:
    resident_pages = int(
      (Path("/proc") / str(pid) / "statm").read_text(encoding="ascii").split()[1]
    )
  except (FileNotFoundError, IndexError, OSError, ValueError):
    return 0
  return resident_pages * int(sysconf("SC_PAGE_SIZE"))


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
    elements.append(_element(
      text,
      kind,
      len(elements),
      offset,
      depth,
      table=table,
      source_spans=_docling_source_spans(item, offset, len(text)),
    ))
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
  source_spans: list[SourceSpan] | None = None,
) -> ExtractionElement:
  checksum = sha256(text.encode("utf-8")).hexdigest()
  return ExtractionElement(
    element_id=f"element-{index}-{checksum[:12]}",
    kind=kind,
    text=text,
    checksum=checksum,
    source_spans=source_spans or [SourceSpan(
      page_number=page_number,
      start_offset=offset,
      end_offset=offset + len(text),
    )],
    heading_level=min(max(depth, 1), 6) if kind is ElementKind.HEADING else None,
    list_level=max(depth - 1, 0) if kind is ElementKind.LIST_ITEM else None,
    list_marker="-" if kind is ElementKind.LIST_ITEM else None,
    table=table,
  )


def _docling_source_spans(item, offset: int, text_length: int) -> list[SourceSpan] | None:
  spans = []
  for provenance in getattr(item, "prov", ()) or ():
    page_number = getattr(provenance, "page_no", None)
    if not isinstance(page_number, int) or page_number < 1:
      continue
    raw_box = getattr(provenance, "bbox", None)
    box = None
    if raw_box is not None:
      coordinates = [getattr(raw_box, name, None) for name in ("l", "t", "r", "b")]
      if all(isinstance(value, (int, float)) for value in coordinates):
        left, top, right, bottom = (max(float(value), 0.0) for value in coordinates)
        box = BoundingBox(
          left=min(left, right),
          top=min(top, bottom),
          right=max(left, right),
          bottom=max(top, bottom),
        )
    spans.append(SourceSpan(
      page_number=page_number,
      start_offset=offset,
      end_offset=offset + text_length,
      bounding_box=box,
    ))
  return spans or None


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
    raise ExtractionRuntimeRejected("parser_wall_time_exceeded")
  if getrusage(RUSAGE_SELF).ru_maxrss * 1024 > request.limits.maximum_peak_memory_bytes:
    raise ExtractionRuntimeRejected("parser_memory_limit_exceeded")
