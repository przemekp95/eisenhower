from hashlib import sha256
from importlib.metadata import version
import json
from pathlib import Path
import re

import pytest

from app.document_extraction.adapters import (
  DOCLING_LAYOUT_MODEL_REVISION,
  DoclingDocumentExtractor,
  ExtractionRuntimeRejected,
  FallbackReason,
  GovernedDocumentExtractor,
  PrimaryFallbackEligible,
  UnstructuredDocumentExtractor,
)
from app.document_extraction.models import (
  ApprovedExtractionRequest,
  ExtractionLimits,
  ExtractionRequest,
  ExtractionSecurityMetadata,
  OCRApproval,
  OCRRequest,
)
from app.document_extraction.inspection import LocalDocumentInspector
from app.document_extraction.policy import FrozenManifestExtractionPolicy


DOCLING_2_119_TABLE_IMAGE_WARNING = (
  "This field is deprecated. Use `generate_page_images=True` and call "
  "`TableItem.get_image()` to extract table images from page images."
)


def extract_with_known_docling_2_119_warning(extractor, request):
  """Pin the narrow upstream warning until Docling is upgraded from 2.119.0."""
  assert version("docling") == "2.119.0"
  with pytest.warns(
    DeprecationWarning,
    match=re.escape(DOCLING_2_119_TABLE_IMAGE_WARNING),
  ) as observed:
    result = extractor.extract(request)

  assert len(observed) == 1
  warning = observed[0]
  assert str(warning.message) == DOCLING_2_119_TABLE_IMAGE_WARNING
  assert Path(warning.filename).as_posix().endswith(
    "/docling/pipeline/standard_pdf_pipeline.py"
  )
  assert warning.lineno == 599
  return result


def approved(path: Path) -> ApprovedExtractionRequest:
  content = path.read_bytes()
  return ApprovedExtractionRequest(
    path=path,
    source_uri=f"eisenhower://repository/corpus/approved-documents/{path.name}",
    media_type={
      ".pdf": "application/pdf",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".html": "text/html",
    }[path.suffix],
    source_checksum=sha256(content).hexdigest(),
    size_bytes=len(content),
    page_count=1,
    manifest_version="eisenhower-corpus-v1",
    limits=ExtractionLimits(
      maximum_document_bytes=20 * 1024 * 1024,
      maximum_document_pages=500,
      maximum_wall_seconds=120,
      maximum_peak_memory_bytes=4 * 1024**3,
    ),
    minimum_primary_text_characters=20,
    security=ExtractionSecurityMetadata(
      prompt_injection_detected=True,
      prompt_injection_categories=["instruction_override"],
    ),
  )


class RecordingExtractor:
  def __init__(self, result=None, error=None):
    self.result = result
    self.error = error
    self.calls = 0

  def extract(self, _request):
    self.calls += 1
    if self.error:
      raise self.error
    return self.result


@pytest.mark.parametrize("reason", list(FallbackReason))
def test_governed_fallback_runs_only_for_the_two_approved_primary_reasons(tmp_path, reason):
  path = tmp_path / "fixture.html"
  path.write_text("<h1>Reviewed fixture</h1>", encoding="utf-8")
  fallback_result = UnstructuredDocumentExtractor(
    partition_function=lambda **_kwargs: [type("Title", (), {"category": "Title", "__str__": lambda _self: "Reviewed fixture"})()]
  ).extract(approved(path))
  primary = RecordingExtractor(error=PrimaryFallbackEligible(reason))
  fallback = RecordingExtractor(result=fallback_result)

  result = GovernedDocumentExtractor(primary, fallback).extract(approved(path))

  assert primary.calls == 1
  assert fallback.calls == 1
  assert result.provenance.fallback_reason == reason.value


@pytest.mark.parametrize("error", [
  ExtractionRuntimeRejected("timeout"),
  MemoryError("oom"),
  ValueError("programming error"),
])
def test_governed_fallback_does_not_mask_security_resource_or_programming_failures(tmp_path, error):
  path = tmp_path / "fixture.html"
  path.write_text("<h1>Reviewed fixture</h1>", encoding="utf-8")
  fallback = RecordingExtractor()

  with pytest.raises(type(error)):
    GovernedDocumentExtractor(RecordingExtractor(error=error), fallback).extract(approved(path))

  assert fallback.calls == 0


def test_real_docling_primary_preserves_html_structure_and_security_metadata():
  path = Path(__file__).resolve().parents[2] / "corpus" / "approved-documents" / "extraction-golden-en.html"

  result = DoclingDocumentExtractor().extract(approved(path))

  kinds = {element.kind.value for element in result.elements}
  assert {"heading", "list_item", "table"}.issubset(kinds)
  assert result.provenance.extractor_name == "docling"
  assert result.provenance.extractor_version == "2.119.0"
  assert result.provenance.ocr.performed is False
  assert result.metadata.prompt_injection_detected is True
  assert result.extraction_checksum == sha256(
    __import__("json").dumps(
      [element.model_dump(mode="json") for element in result.elements],
      sort_keys=True,
      separators=(",", ":"),
      ensure_ascii=False,
    ).encode("utf-8")
  ).hexdigest()


def test_real_pdf_runs_through_pinned_local_docling_and_unstructured_engines():
  path = Path(__file__).resolve().parents[2] / "corpus" / "approved-documents" / "extraction-golden-pdf.pdf"

  primary = extract_with_known_docling_2_119_warning(
    DoclingDocumentExtractor(),
    approved(path),
  )
  fallback = UnstructuredDocumentExtractor().extract(approved(path))

  assert DOCLING_LAYOUT_MODEL_REVISION == "40bde044036bb181c130ddf6c51792187268748f"
  assert "Corpus PDF validation" in "\n".join(item.text for item in primary.elements)
  assert "Corpus PDF validation" in "\n".join(item.text for item in fallback.elements)
  assert primary.provenance.ocr.performed is False
  assert fallback.provenance.ocr.performed is False


def test_real_ocr_uses_the_exact_owner_frozen_receipt_and_local_tesseract_cli():
  repository_root = Path(__file__).resolve().parents[2]
  path = repository_root / "corpus" / "approved-documents" / "extraction-golden-ocr.pdf"
  manifest = json.loads(
    (repository_root / "docs" / "ai-rebuild" / "corpus-manifest-v1.json").read_text(
      encoding="utf-8"
    )
  )
  policy = FrozenManifestExtractionPolicy.from_manifest(repository_root, manifest)
  approval = OCRApproval.model_validate(manifest["document_policy"]["ocr_approvals"][0])
  request = policy.authorize(ExtractionRequest(
    source=str(path),
    inspection=LocalDocumentInspector().inspect(path),
    ocr=OCRRequest(languages=["en"], approval=approval),
  ))

  result = extract_with_known_docling_2_119_warning(DoclingDocumentExtractor(), request)

  assert "OCR VALIDATION HUMAN APPROVAL REQUIRED" in " ".join(
    item.text for item in result.elements
  )
  assert result.provenance.ocr.performed is True
  assert result.provenance.ocr.engine_name == "tesseract-cli"
  assert result.provenance.ocr.engine_version == "5.3.4"
  assert result.provenance.ocr.human_approval_id == approval.approval_id


def test_real_unstructured_fallback_runs_locally_without_ocr_or_remote_services():
  path = Path(__file__).resolve().parents[2] / "corpus" / "approved-documents" / "extraction-golden-pl.html"

  result = UnstructuredDocumentExtractor().extract(approved(path))

  assert result.provenance.extractor_name == "unstructured"
  assert result.provenance.extractor_version == "0.25.2"
  assert result.provenance.ocr.performed is False
  assert any("Plan walidacji" in element.text for element in result.elements)


def test_real_quality_gate_invokes_unstructured_with_recorded_fallback_reason():
  path = Path(__file__).resolve().parents[2] / "corpus" / "approved-documents" / "extraction-golden-en.html"
  request = approved(path).model_copy(update={"minimum_primary_text_characters": 100_000})

  result = GovernedDocumentExtractor(
    DoclingDocumentExtractor(),
    UnstructuredDocumentExtractor(),
  ).extract(request)

  assert result.provenance.extractor_name == "unstructured"
  assert result.provenance.fallback_reason == "PRIMARY_QUALITY_BELOW_APPROVED_THRESHOLD"
