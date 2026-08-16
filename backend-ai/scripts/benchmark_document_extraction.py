from __future__ import annotations

from argparse import ArgumentParser
from hashlib import sha256
from importlib.metadata import version
import json
from math import floor
from multiprocessing import get_context
from multiprocessing.connection import Connection
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
from app.document_extraction.models import (
  ApprovedExtractionRequest,
  ExtractionRequest,
  OCRApproval,
  OCRRequest,
)
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


def _percentile(values: list[float], quantile: float) -> float:
  ordered = sorted(values)
  position = (len(ordered) - 1) * quantile
  lower = floor(position)
  upper = min(lower + 1, len(ordered) - 1)
  fraction = position - lower
  return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def summarize_runs(runs: list[dict]) -> dict:
  summary = {}
  for mode in ("cold", "warm"):
    selected = [run for run in runs if run["mode"] == mode]
    elapsed = [float(run["elapsed_seconds"]) for run in selected]
    if not elapsed:
      continue
    summary[mode] = {
      "repetitions": len(selected),
      "elapsed_seconds_p50": round(_percentile(elapsed, 0.50), 6),
      "elapsed_seconds_p95": round(_percentile(elapsed, 0.95), 6),
      "process_peak_rss_bytes_max": max(
        int(run["process_peak_rss_bytes"]) for run in selected
      ),
    }
  return summary


def _parser(parser_role: str):
  if parser_role == "docling-primary":
    return DoclingDocumentExtractor()
  if parser_role == "unstructured-controlled-fallback":
    return UnstructuredDocumentExtractor()
  raise ValueError("unknown parser role")


def _benchmark_child(
  connection: Connection,
  parser_role: str,
  request_payload: dict,
  expected_phrases: list[str],
  repetitions: int,
  warmup: bool,
) -> None:
  try:
    parser = _parser(parser_role)
    request = ApprovedExtractionRequest.model_validate(request_payload)
    if warmup:
      parser.extract(request)
    runs = []
    for _ in range(repetitions):
      started = perf_counter()
      result = parser.extract(request)
      elapsed = perf_counter() - started
      combined_text = "\n".join(element.text for element in result.elements)
      runs.append({
        "elapsed_seconds": round(elapsed, 6),
        "process_peak_rss_bytes": getrusage(RUSAGE_SELF).ru_maxrss * 1024,
        "elements": len(result.elements),
        "element_kinds": sorted({element.kind.value for element in result.elements}),
        "required_phrases_present": all(
          phrase in combined_text for phrase in expected_phrases
        ),
        "extraction_sha256": result.extraction_checksum,
        "extractor_name": result.provenance.extractor_name,
        "extractor_version": result.provenance.extractor_version,
        "ocr_performed": result.provenance.ocr.performed,
        "ocr_engine": result.provenance.ocr.engine_name,
        "ocr_engine_version": result.provenance.ocr.engine_version,
        "ocr_approval_id": result.provenance.ocr.human_approval_id,
      })
    connection.send(("ok", runs))
  except Exception as error:
    connection.send(("error", error.__class__.__name__))
  finally:
    connection.close()


def _run_batch(
  parser_role: str,
  request: ApprovedExtractionRequest,
  expected_phrases: list[str],
  repetitions: int,
  *,
  warmup: bool,
) -> list[dict]:
  context = get_context("spawn")
  parent, child = context.Pipe(duplex=False)
  process = context.Process(
    target=_benchmark_child,
    args=(
      child,
      parser_role,
      request.model_dump(mode="python"),
      expected_phrases,
      repetitions,
      warmup,
    ),
  )
  process.start()
  child.close()
  maximum_seconds = request.limits.maximum_wall_seconds * (repetitions + int(warmup)) + 30
  try:
    if not parent.poll(maximum_seconds):
      raise RuntimeError("document extraction benchmark child timed out")
    status, payload = parent.recv()
    if status != "ok":
      raise RuntimeError(f"document extraction benchmark child failed: {payload}")
    return payload
  finally:
    parent.close()
    if process.is_alive():
      process.terminate()
    process.join(timeout=5)
    if process.is_alive():
      process.kill()
      process.join(timeout=5)


def benchmark_case(
  parser_role: str,
  request: ApprovedExtractionRequest,
  expected_phrases: list[str],
  *,
  cold_repetitions: int,
  warm_repetitions: int,
) -> dict:
  cold_runs = []
  for _ in range(cold_repetitions):
    cold_runs.extend(_run_batch(
      parser_role,
      request,
      expected_phrases,
      1,
      warmup=False,
    ))
  warm_runs = _run_batch(
    parser_role,
    request,
    expected_phrases,
    warm_repetitions,
    warmup=True,
  )
  for run in cold_runs:
    run["mode"] = "cold"
  for run in warm_runs:
    run["mode"] = "warm"
  runs = cold_runs + warm_runs
  reference = runs[-1]
  return {
    "source": request.path.name,
    "source_sha256": request.source_checksum,
    "parser_role": parser_role,
    "extractor_name": reference["extractor_name"],
    "extractor_version": reference["extractor_version"],
    "elements": reference["elements"],
    "element_kinds": reference["element_kinds"],
    "required_phrases_present": all(
      run["required_phrases_present"] for run in runs
    ),
    "extraction_sha256": reference["extraction_sha256"],
    "ocr_performed": reference["ocr_performed"],
    "ocr_engine": reference["ocr_engine"],
    "ocr_engine_version": reference["ocr_engine_version"],
    "ocr_approval_id": reference["ocr_approval_id"],
    "runs": runs,
    "summary": summarize_runs(runs),
  }


def main() -> None:
  arguments = ArgumentParser()
  arguments.add_argument("--cold-repetitions", type=int, default=3)
  arguments.add_argument("--warm-repetitions", type=int, default=5)
  options = arguments.parse_args()
  if options.cold_repetitions < 1 or options.warm_repetitions < 1:
    arguments.error("repetitions must be positive")

  repository_root = Path(__file__).resolve().parents[2]
  manifest_path = repository_root / "docs" / "ai-rebuild" / "corpus-manifest-v1.json"
  manifest_bytes = manifest_path.read_bytes()
  manifest = json.loads(manifest_bytes)
  policy = FrozenManifestExtractionPolicy.from_manifest(repository_root, manifest)
  inspector = LocalDocumentInspector()
  cases = []
  for filename, phrases in EXPECTED.items():
    source = repository_root / "corpus" / "approved-documents" / filename
    approved = policy.authorize(
      ExtractionRequest(source=str(source), inspection=inspector.inspect(source))
    )
    for parser_role in ("docling-primary", "unstructured-controlled-fallback"):
      cases.append(benchmark_case(
        parser_role,
        approved,
        phrases,
        cold_repetitions=options.cold_repetitions,
        warm_repetitions=options.warm_repetitions,
      ))

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
  approval = OCRApproval.model_validate(manifest["document_policy"]["ocr_approvals"][0])
  ocr_request = policy.authorize(ExtractionRequest(
    source=str(ocr_source),
    inspection=ocr_inspection,
    ocr=OCRRequest(languages=["en"], approval=approval),
  ))
  cases.append(benchmark_case(
    "docling-primary",
    ocr_request,
    ["OCR VALIDATION HUMAN APPROVAL REQUIRED"],
    cold_repetitions=options.cold_repetitions,
    warm_repetitions=options.warm_repetitions,
  ))

  print(json.dumps({
    "schema_version": "document-extraction-benchmark-v2",
    "evidence_scope": "local_synthetic_smoke_only",
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
    "cold_repetitions": options.cold_repetitions,
    "warm_repetitions": options.warm_repetitions,
    "ocr_without_frozen_receipt_rejection": ocr_without_receipt_rejection,
    "synthetic_fixture_notice": (
      "Local smoke benchmark only; representative human review and deployed runtime "
      "validation remain separate gates."
    ),
    "cases": cases,
  }, indent=2, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
  main()
