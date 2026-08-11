from hashlib import sha256

from app.document_extraction.application import ApprovedDocumentIngestionApplication
from app.document_extraction.models import (
  ApprovedExtractionRequest,
  DocumentInspection,
  ElementKind,
  ExtractedDocument,
  ExtractionElement,
  ExtractionLimits,
  ExtractionMetadata,
  ExtractionProvenance,
  ExtractionSecurityMetadata,
  OCRProvenance,
  PromptInjectionSignal,
  SecretScanResult,
  SourceSpan,
  TableData,
)
from app.rag.models import AccessScope


class Inspector:
  def inspect(self, path):
    assert path.name == "approved.html"
    return DocumentInspection(
      media_type="text/html",
      page_count=1,
      encrypted=False,
      archive=False,
      embedded_executable=False,
      malformed=False,
      estimated_wall_seconds=1,
      estimated_peak_memory_bytes=1024,
      secret_scan=SecretScanResult(completed=True, secret_detected=False),
      prompt_injection=PromptInjectionSignal(completed=True, detected=True, categories=["override"]),
    )


class Preflight:
  def __init__(self, approved):
    self.approved = approved

  def authorize(self, request):
    assert request.inspection.prompt_injection.detected is True
    return self.approved


class Extractor:
  def __init__(self, result):
    self.result = result

  def extract(self, _request):
    return self.result


class Canonical:
  def __init__(self):
    self.documents = []

  def ingest(self, documents):
    self.documents.extend(documents)
    return {"accepted": len(documents), "projected": len(documents), "pending": 0}


def element(identifier, kind, text, **kwargs):
  return ExtractionElement(
    element_id=identifier,
    kind=kind,
    text=text,
    checksum=sha256(text.encode()).hexdigest(),
    source_spans=[SourceSpan(start_offset=0, end_offset=len(text))],
    **kwargs,
  )


def test_approved_extraction_is_mapped_to_canonical_rag_with_provenance(tmp_path):
  path = tmp_path / "approved.html"
  path.write_text("<h1>Architecture</h1>", encoding="utf-8")
  limits = ExtractionLimits(
    maximum_document_bytes=1024,
    maximum_document_pages=10,
    maximum_wall_seconds=5,
    maximum_peak_memory_bytes=1024 * 1024,
  )
  approved = ApprovedExtractionRequest(
    path=path,
    source_uri="eisenhower://repository/corpus/approved-documents/approved.html",
    media_type="text/html",
    source_checksum=sha256(path.read_bytes()).hexdigest(),
    size_bytes=path.stat().st_size,
    page_count=1,
    manifest_version="corpus-v1",
    limits=limits,
    minimum_primary_text_characters=20,
    security=ExtractionSecurityMetadata(prompt_injection_detected=True, prompt_injection_categories=["override"]),
  )
  extracted = ExtractedDocument(
    source_uri=approved.source_uri,
    source_checksum=approved.source_checksum,
    extraction_checksum="a" * 64,
    media_type="text/html",
    elements=[
      element("heading", ElementKind.HEADING, "Architecture", heading_level=1),
      element("list", ElementKind.LIST_ITEM, "Fail closed", list_level=0, list_marker="-"),
      element("table", ElementKind.TABLE, "Gate | Status", table=TableData(rows=[["Gate", "Status"]])),
    ],
    provenance=ExtractionProvenance(
      extractor_name="docling",
      extractor_version="2.119.0",
      extraction_contract_version="document-extraction-v1",
      ocr=OCRProvenance(requested=False, performed=False),
    ),
    metadata=ExtractionMetadata(prompt_injection_detected=True, prompt_injection_categories=["override"]),
  )
  canonical = Canonical()
  app = ApprovedDocumentIngestionApplication(
    Inspector(),
    Preflight(approved),
    Extractor(extracted),
    canonical,
  )

  result = app.ingest(
    str(path),
    scope=AccessScope(tenant_id="tenant-1", user_id="owner-1", project_ids=["project-1"]),
    source_sequence=8,
  )

  assert result == {"accepted": 1, "projected": 1, "pending": 0}
  document = canonical.documents[0]
  assert document.text == "# Architecture\n\n- Fail closed\n\nGate | Status"
  assert document.extraction_checksum == "a" * 64
  assert document.extractor_name == "docling"
  assert document.prompt_injection_detected is True
  assert document.source_sequence == 8
  assert document.acl_subjects == ["tenant:tenant-1", "user:owner-1", "project:project-1"]
