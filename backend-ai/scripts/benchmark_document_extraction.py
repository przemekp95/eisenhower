from __future__ import annotations

from hashlib import sha256
from importlib.metadata import version
import json
from pathlib import Path
from resource import RUSAGE_SELF, getrusage
from time import perf_counter

from app.document_extraction.adapters import (
  DOCLING_LAYOUT_MODEL_REPOSITORY,
  DOCLING_LAYOUT_MODEL_REVISION,
  DoclingDocumentExtractor,
  UnstructuredDocumentExtractor,
)
from app.document_extraction.inspection import LocalDocumentInspector
from app.document_extraction.models import ExtractionRequest, OCRApproval, OCRRequest
from app.document_extraction.policy import (
  ExtractionPreflightRejected,
  FrozenManifestExtractionPolicy,
)


EXPECTED = {
  "extraction-golden-pdf.pdf": ["Corpus PDF validation", "Human OCR gate"],
  "extraction-golden-docx.docx": ["Walidacja dokumentu DOCX", "Kontrola człowieka"],
  "extraction-golden-pptx.pptx": ["PPTX extraction validation", "Approved"],
  "extraction-golden-pl.html": ["Plan walidacji korpusu", "Wymaga kontroli"],
  "extraction-golden-en.html": ["Corpus validation plan", "Human review"],
}


def main() -> None:
  repository_root = Path(__file__).resolve().parents[2]
  manifest_path = repository_root / "docs" / "ai-rebuild" / "corpus-manifest-v1.json"
  manifest_bytes = manifest_path.read_bytes()
  manifest = json.loads(manifest_bytes)
  policy = FrozenManifestExtractionPolicy.from_manifest(repository_root, manifest)
  inspector = LocalDocumentInspector()
  parsers = {
    "docling-primary": DoclingDocumentExtractor(),
    "unstructured-controlled-fallback": UnstructuredDocumentExtractor(),
  }
  cases = []
  for filename, phrases in EXPECTED.items():
    source = repository_root / "corpus" / "approved-documents" / filename
    approved = policy.authorize(
      ExtractionRequest(source=str(source), inspection=inspector.inspect(source))
    )
    for parser_name, parser in parsers.items():
      started = perf_counter()
      before = getrusage(RUSAGE_SELF).ru_maxrss * 1024
      result = parser.extract(approved)
      elapsed = perf_counter() - started
      peak = getrusage(RUSAGE_SELF).ru_maxrss * 1024
      combined_text = "\n".join(element.text for element in result.elements)
      kinds = sorted({element.kind.value for element in result.elements})
      cases.append({
        "source": filename,
        "source_sha256": approved.source_checksum,
        "parser_role": parser_name,
        "extractor_name": result.provenance.extractor_name,
        "extractor_version": result.provenance.extractor_version,
        "elapsed_seconds": round(elapsed, 6),
        "process_peak_rss_before_bytes": before,
        "process_peak_rss_after_bytes": peak,
        "elements": len(result.elements),
        "element_kinds": kinds,
        "required_phrases_present": all(phrase in combined_text for phrase in phrases),
        "extraction_sha256": result.extraction_checksum,
        "ocr_performed": result.provenance.ocr.performed,
      })
  ocr_source = repository_root / "corpus" / "approved-documents" / "extraction-golden-ocr.pdf"
  ocr_inspection = inspector.inspect(ocr_source)
  try:
    policy.authorize(ExtractionRequest(
      source=str(ocr_source),
      inspection=ocr_inspection,
      ocr=OCRRequest(languages=["en"]),
    ))
    ocr_without_receipt_rejection = None
  except ExtractionPreflightRejected as error:
    ocr_without_receipt_rejection = error.code.value
  ocr_approval = OCRApproval.model_validate(manifest["document_policy"]["ocr_approvals"][0])
  ocr_request = policy.authorize(ExtractionRequest(
    source=str(ocr_source),
    inspection=ocr_inspection,
    ocr=OCRRequest(languages=["en"], approval=ocr_approval),
  ))
  started = perf_counter()
  before = getrusage(RUSAGE_SELF).ru_maxrss * 1024
  ocr_result = parsers["docling-primary"].extract(ocr_request)
  elapsed = perf_counter() - started
  peak = getrusage(RUSAGE_SELF).ru_maxrss * 1024
  ocr_text = "\n".join(element.text for element in ocr_result.elements)
  cases.append({
    "source": ocr_source.name,
    "source_sha256": ocr_request.source_checksum,
    "parser_role": "docling-primary-approved-ocr",
    "extractor_name": ocr_result.provenance.extractor_name,
    "extractor_version": ocr_result.provenance.extractor_version,
    "elapsed_seconds": round(elapsed, 6),
    "process_peak_rss_before_bytes": before,
    "process_peak_rss_after_bytes": peak,
    "elements": len(ocr_result.elements),
    "element_kinds": sorted({element.kind.value for element in ocr_result.elements}),
    "required_phrases_present": "OCR VALIDATION HUMAN APPROVAL REQUIRED" in ocr_text,
    "extraction_sha256": ocr_result.extraction_checksum,
    "ocr_performed": ocr_result.provenance.ocr.performed,
    "ocr_engine": ocr_result.provenance.ocr.engine_name,
    "ocr_engine_version": ocr_result.provenance.ocr.engine_version,
    "ocr_approval_id": ocr_result.provenance.ocr.human_approval_id,
  })
  print(json.dumps({
    "schema_version": "document-extraction-benchmark-v1",
    "manifest_version": manifest["manifest_version"],
    "manifest_sha256": sha256(manifest_bytes).hexdigest(),
    "dependency_versions": {
      "docling": version("docling"),
      "onnxruntime": version("onnxruntime"),
      "torch": version("torch"),
      "torchvision": version("torchvision"),
      "unstructured": version("unstructured"),
      "unstructured-inference": version("unstructured-inference"),
    },
    "docling_layout_model": {
      "repository": DOCLING_LAYOUT_MODEL_REPOSITORY,
      "revision": DOCLING_LAYOUT_MODEL_REVISION,
    },
    "offline": True,
    "ocr_without_frozen_receipt_rejection": ocr_without_receipt_rejection,
    "synthetic_fixture_notice": "Smoke benchmark only; representative human review remains a separate gate.",
    "cases": cases,
  }, indent=2, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
  main()
