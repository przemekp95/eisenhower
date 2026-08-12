from __future__ import annotations

import argparse
from hashlib import sha256
from importlib.metadata import version
import json
from pathlib import Path
from time import perf_counter
from uuid import uuid4

import httpx
from pymongo import MongoClient
from qdrant_client import QdrantClient, models as qmodels
from sentence_transformers import SentenceTransformer

from app.config import Settings
from app.rag.adapters import QdrantIngestionAdapter, QdrantRetriever
from app.rag.canonical import CanonicalIngestionApplication, CanonicalRetriever
from app.rag.collections import QdrantCollectionManager
from app.rag.corpus_manifest import CorpusManifest, RepositoryCorpusConnector
from app.rag.golden import load_golden_dataset
from app.rag.golden_runner import RetrievalStrategyComparisonRunner
from app.rag.hybrid import CanonicalBm25Retriever, HybridRetriever
from app.rag.ingestion import DeterministicChunker
from app.rag.models import AccessScope
from app.rag.mongo_document_store import MongoCanonicalDocumentStore
from scripts.verify_qdrant_recovery import verify_candidate_collection_snapshot


class PinnedMiniLMEmbedding:
  version = "minilm-v1"

  def __init__(self, model_name: str, revision: str):
    self.model_name = model_name
    self.revision = revision
    self.encoder = SentenceTransformer(model_name, revision=revision)

  def embed(self, texts: list[str]) -> list[list[float]]:
    vectors = self.encoder.encode(
      texts,
      normalize_embeddings=True,
      convert_to_numpy=True,
      show_progress_bar=False,
    )
    return [[float(value) for value in vector] for vector in vectors.tolist()]


def _delete_alias(client: QdrantClient, alias: str) -> None:
  aliases = {item.alias_name for item in client.get_aliases().aliases}
  if alias in aliases:
    client.update_collection_aliases(change_aliases_operations=[
      qmodels.DeleteAliasOperation(delete_alias=qmodels.DeleteAlias(alias_name=alias))
    ])


def run(
  candidate_path: Path,
  snapshot_output: Path | None = None,
  repository_root: Path | None = None,
) -> dict:
  repository_root = (repository_root or Path(__file__).resolve().parents[2]).resolve()
  manifest_path = repository_root / "docs" / "ai-rebuild" / "corpus-manifest-v1.json"
  manifest = CorpusManifest.load(manifest_path)
  candidate_bytes = candidate_path.read_bytes()
  cases = load_golden_dataset(candidate_path)
  if any(case.dataset_version != "retrieval-review-candidate-v1-unapproved" for case in cases):
    raise ValueError("this runner accepts only the explicitly unapproved review candidate")

  settings = Settings(
    training_data_path=repository_root / "data" / "training.jsonl",
    model_cache_dir=repository_root / "data" / "models",
  )
  embedding = PinnedMiniLMEmbedding(
    settings.local_model_name,
    settings.local_model_revision,
  )
  vector_size = len(embedding.embed(["dimension probe"])[0])
  suffix = uuid4().hex
  database_name = f"eisenhower_task013_candidate_{suffix}"
  collection_name = f"task013_candidate_{suffix}"
  alias = f"task013_candidate_active_{suffix}"
  mongo = MongoClient("mongodb://127.0.0.1:27017", serverSelectionTimeoutMS=3_000)
  qdrant = QdrantClient(url="http://127.0.0.1:6333", timeout=20)
  manager = QdrantCollectionManager(qdrant, alias=alias, vector_size=vector_size)
  cleanup = {"mongo_database_dropped": False, "qdrant_collection_deleted": False}
  report = None
  started = perf_counter()
  try:
    assert mongo.admin.command("ping")["ok"] == 1.0
    server = httpx.get("http://127.0.0.1:6333/", timeout=5).raise_for_status().json()
    manager.ensure_active(collection_name)
    scope = AccessScope(
      tenant_id="eisenhower-owner",
      user_id="eisenhower-owner",
      project_ids=["eisenhower"],
    )
    documents = RepositoryCorpusConnector(repository_root, manifest).load_initial(scope)
    store = MongoCanonicalDocumentStore(mongo[database_name].rag_documents)
    projection = QdrantIngestionAdapter(qdrant, collection_name=alias)
    ingestion = CanonicalIngestionApplication(
      embedding,
      store,
      projection,
      DeterministicChunker(max_chars=1200, overlap_chars=160),
    )
    ingestion_result = ingestion.ingest(documents)
    reconciliation = ingestion.reconcile(scope.tenant_id, "eisenhower")
    if ingestion_result["accepted"] != len(documents) or ingestion_result["pending"] != 0:
      raise RuntimeError("candidate corpus did not reach the canonical and projection stores")
    if reconciliation != {"projected": 0, "pending": 0, "drifted": 0}:
      raise RuntimeError("candidate corpus projection did not reconcile cleanly")

    dense_retriever = CanonicalRetriever(
      QdrantRetriever(qdrant, embedding, collection_alias=alias),
      store,
      embedding_version=embedding.version,
      chunker=DeterministicChunker(max_chars=1200, overlap_chars=160),
    )
    lexical_retriever = CanonicalBm25Retriever(
      store,
      embedding_version=embedding.version,
      chunker=DeterministicChunker(max_chars=1200, overlap_chars=160),
    )
    hybrid_retriever = HybridRetriever(dense_retriever, lexical_retriever)
    strategy_comparison = RetrievalStrategyComparisonRunner({
      "dense": dense_retriever,
      "hybrid": hybrid_retriever,
    }).run(cases, k=5)
    recovery = (
      verify_candidate_collection_snapshot(qdrant, manager, collection_name, snapshot_output)
      if snapshot_output is not None else None
    )
    report = {
      "schema_version": "retrieval-candidate-runtime-v1",
      "evidence_level": "local-container-runtime",
      "approval_status": "human_review_required",
      "tuning_performed": False,
      "deployment_proven": False,
      "public_evidence_proven": False,
      "candidate_sha256": sha256(candidate_bytes).hexdigest(),
      "manifest_sha256": sha256(manifest_path.read_bytes()).hexdigest(),
      "corpus_snapshot_sha256": manifest.initial_snapshot.sha256,
      "model": {
        "id": embedding.model_name,
        "revision": embedding.revision,
        "embedding_version": embedding.version,
        "vector_size": vector_size,
      },
      "runtime": {
        "qdrant_server_version": server["version"],
        "qdrant_server_commit": server["commit"],
        "qdrant_client_version": version("qdrant-client"),
        "pymongo_version": version("pymongo"),
        "sentence_transformers_version": version("sentence-transformers"),
      },
      "ingestion": ingestion_result,
      "reconciliation": reconciliation,
      "evaluation": strategy_comparison["strategies"]["dense"],
      "strategy_comparison": strategy_comparison,
      "collection": {"name": collection_name, "revision": embedding.version},
      "snapshot_restore": recovery,
      "total_seconds_before_cleanup": round(perf_counter() - started, 6),
      "cleanup": cleanup,
    }
  finally:
    mongo.drop_database(database_name)
    cleanup["mongo_database_dropped"] = True
    _delete_alias(qdrant, alias)
    if qdrant.collection_exists(collection_name):
      qdrant.delete_collection(collection_name=collection_name)
    cleanup["qdrant_collection_deleted"] = True
    qdrant.close()
    mongo.close()
  if report is None or not all(cleanup.values()):
    raise RuntimeError("retrieval candidate runtime did not finish with verified cleanup")
  return report


def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument("--candidate", type=Path, required=True)
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument(
    "--repository-root", type=Path,
    help="Read the frozen corpus from an explicit clean exact-SHA checkout.",
  )
  args = parser.parse_args()
  report = run(args.candidate, repository_root=args.repository_root)
  args.output.parent.mkdir(parents=True, exist_ok=True)
  args.output.write_text(
    json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
    encoding="utf-8",
  )
  print(json.dumps({
    "output": str(args.output),
    "sha256": sha256(args.output.read_bytes()).hexdigest(),
    "metrics": report["strategy_comparison"]["strategies"],
    "cleanup": report["cleanup"],
  }, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
  main()
