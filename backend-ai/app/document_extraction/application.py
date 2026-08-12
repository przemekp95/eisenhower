from __future__ import annotations

from hashlib import sha256
from pathlib import Path

from ..rag.models import AccessScope, SourceDocument
from .models import ElementKind, ExtractionRequest, OCRRequest


class ApprovedDocumentIngestionApplication:
  def __init__(self, inspector, preflight, extractor, canonical_ingestion):
    self.inspector = inspector
    self.preflight = preflight
    self.extractor = extractor
    self.canonical_ingestion = canonical_ingestion

  def ingest(
    self,
    source: str,
    *,
    scope: AccessScope,
    source_sequence: int,
    ocr: OCRRequest | None = None,
  ) -> dict:
    inspection = self.inspector.inspect(Path(source))
    approved = self.preflight.authorize(
      ExtractionRequest(source=source, inspection=inspection, ocr=ocr)
    )
    extracted = self.extractor.extract(approved)
    normalized_text = _structured_text(extracted.elements)
    title = next(
      (element.text for element in extracted.elements if element.kind is ElementKind.HEADING),
      approved.path.stem,
    )
    provenance = extracted.provenance
    ocr_provenance = provenance.ocr
    document = SourceDocument(
      document_id=sha256(extracted.source_uri.encode("utf-8")).hexdigest(),
      tenant_id=scope.tenant_id,
      project_id=scope.project_ids[0] if scope.project_ids else None,
      owner_id=scope.user_id,
      source_type="project_context",
      source_uri=extracted.source_uri,
      title=title,
      text=normalized_text,
      source_revision=extracted.source_checksum,
      content_version=f"{approved.manifest_version}:{extracted.extraction_checksum}",
      content_checksum=sha256(normalized_text.encode("utf-8")).hexdigest(),
      source_sequence=source_sequence,
      acl_subjects=scope.acl_subjects,
      extraction_contract_version=provenance.extraction_contract_version,
      extraction_checksum=extracted.extraction_checksum,
      extractor_name=provenance.extractor_name,
      extractor_version=provenance.extractor_version,
      ocr_approval_id=ocr_provenance.human_approval_id,
      prompt_injection_detected=extracted.metadata.prompt_injection_detected,
    )
    return self.canonical_ingestion.ingest([document])


def _structured_text(elements) -> str:
  records = []
  for element in elements:
    if element.kind is ElementKind.HEADING:
      records.append(f"{'#' * element.heading_level} {element.text}")
    elif element.kind is ElementKind.LIST_ITEM:
      indent = "  " * element.list_level
      records.append(f"{indent}{element.list_marker or '-'} {element.text}")
    else:
      records.append(element.text)
  return "\n\n".join(records).strip()
