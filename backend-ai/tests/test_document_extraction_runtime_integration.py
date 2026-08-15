import json
import os
from pathlib import Path
from uuid import uuid4

import pytest

from app.document_extraction.adapters import (
  DoclingDocumentExtractor,
  GovernedDocumentExtractor,
  UnstructuredDocumentExtractor,
)
from app.document_extraction.application import ApprovedDocumentIngestionApplication
from app.document_extraction.inspection import LocalDocumentInspector
from app.document_extraction.models import OCRApproval, OCRRequest
from app.document_extraction.policy import FrozenManifestExtractionPolicy
from app.rag.canonical import CanonicalIngestionApplication
from app.rag.llamaindex_engine import LlamaIndexChunkingEngine
from app.rag.models import AccessScope
from app.rag.mongo_document_store import MongoCanonicalDocumentStore
from app.rag.qdrant_llamaindex import LlamaIndexQdrantProjection


pytestmark = pytest.mark.skipif(
  os.getenv("RUN_LIVE_DOCUMENT_EXTRACTION") != "1",
  reason="requires explicitly enabled local Docling, MongoDB and Qdrant runtimes",
)


class DeterministicEmbedding:
  version = "document-extraction-runtime-v1"

  @staticmethod
  def embed(texts):
    return [[float(len(text)), float(index), 1.0] for index, text in enumerate(texts)]


def test_approved_formats_and_owner_approved_ocr_reach_canonical_mongo_and_qdrant():
  from pymongo import MongoClient
  from qdrant_client import QdrantClient

  repository_root = Path(__file__).resolve().parents[2]
  manifest = json.loads(
    (repository_root / "docs" / "ai-rebuild" / "corpus-manifest-v1.json").read_text(
      encoding="utf-8"
    )
  )
  suffix = uuid4().hex
  database_name = f"eisenhower_task018_verify_{suffix}"
  collection_name = f"task018_verify_{suffix}"
  mongo = MongoClient("mongodb://127.0.0.1:27017", serverSelectionTimeoutMS=3_000)
  qdrant = QdrantClient(url="http://127.0.0.1:6333", timeout=10)
  try:
    assert mongo.admin.command("ping")["ok"] == 1.0
    store = MongoCanonicalDocumentStore(mongo[database_name].rag_documents)
    projection = LlamaIndexQdrantProjection(
      qdrant,
      DeterministicEmbedding(),
      collection_name=collection_name,
    )
    canonical = CanonicalIngestionApplication(
      DeterministicEmbedding(),
      store,
      projection,
      LlamaIndexChunkingEngine(
        chunk_size=512,
        chunk_overlap=64,
        pipeline_version="llama-document-extraction-v1",
      ),
    )
    application = ApprovedDocumentIngestionApplication(
      LocalDocumentInspector(),
      FrozenManifestExtractionPolicy.from_manifest(repository_root, manifest),
      GovernedDocumentExtractor(
        DoclingDocumentExtractor(),
        UnstructuredDocumentExtractor(),
      ),
      canonical,
    )
    scope = AccessScope(
      tenant_id="eisenhower-owner",
      user_id="eisenhower-owner",
      project_ids=["eisenhower"],
    )
    sources = [
      "extraction-golden-pdf.pdf",
      "extraction-golden-docx.docx",
      "extraction-golden-pptx.pptx",
      "extraction-golden-pl.html",
      "extraction-golden-en.html",
    ]
    for sequence, filename in enumerate(sources, start=1):
      result = application.ingest(
        str(repository_root / "corpus" / "approved-documents" / filename),
        scope=scope,
        source_sequence=sequence,
      )
      assert {key: result[key] for key in ("accepted", "projected", "pending")} == {
        "accepted": 1,
        "projected": 1,
        "pending": 0,
      }

    receipt = OCRApproval.model_validate(manifest["document_policy"]["ocr_approvals"][0])
    ocr_result = application.ingest(
      str(repository_root / "corpus" / "approved-documents" / "extraction-golden-ocr.pdf"),
      scope=scope,
      source_sequence=6,
      ocr=OCRRequest(languages=["en"], approval=receipt),
    )
    assert {key: ocr_result[key] for key in ("accepted", "projected", "pending")} == {
      "accepted": 1,
      "projected": 1,
      "pending": 0,
    }

    persisted = list(mongo[database_name].rag_documents.find({"deleted": False}))
    assert len(persisted) == 6
    assert all(item["projection_pending"] is False for item in persisted)
    assert all(item["extractor_name"] == "docling" for item in persisted)
    assert all(item["extraction_checksum"] for item in persisted)
    assert sum(item["prompt_injection_detected"] for item in persisted) == 1
    ocr_document = next(item for item in persisted if item["ocr_approval_id"] is not None)
    assert ocr_document["ocr_approval_id"] == receipt.approval_id
    assert len(projection.projected_chunks(ocr_document["document_id"], scope.tenant_id)) >= 1
    assert canonical.reconcile(scope.tenant_id, "eisenhower") == {
      "projected": 0,
      "pending": 0,
      "drifted": 0,
    }
  finally:
    mongo.drop_database(database_name)
    if qdrant.collection_exists(collection_name):
      qdrant.delete_collection(collection_name=collection_name)
    qdrant.close()
    mongo.close()
