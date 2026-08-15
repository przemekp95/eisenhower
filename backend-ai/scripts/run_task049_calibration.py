#!/usr/bin/env python3
from __future__ import annotations

import argparse
from hashlib import sha256
from importlib.metadata import version
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
from time import perf_counter
from uuid import uuid4

import httpx
from pymongo import MongoClient
from qdrant_client import QdrantClient, models as qmodels

PROJECT_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = PROJECT_ROOT.parent
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.rag.adapters import (
  QdrantIngestionAdapter,
  QdrantRetriever,
  SentenceTransformerEmbeddingProvider,
)
from app.rag.canonical import CanonicalIngestionApplication, CanonicalRetriever
from app.rag.collections import QdrantCollectionManager
from app.rag.golden_runner import RetrievalGoldenRunner
from app.rag.hybrid import CanonicalBm25Retriever
from app.rag.ingestion import DeterministicChunker
from app.rag.mongo_document_store import MongoCanonicalDocumentStore
from app.rag.task049_evaluation import (
  assert_no_query_overlap,
  build_candidates,
  confidence_features,
  generate_dataset,
  seed_commitment,
  serialize_cases,
  serialize_documents,
  select_candidate,
)
from app.rag.models import AccessScope, RetrievalQuery


def _digest(path: Path) -> str:
  return sha256(path.read_bytes()).hexdigest()


def _delete_collection(client: QdrantClient, manager: QdrantCollectionManager, name: str) -> None:
  aliases = {item.alias_name for item in client.get_aliases().aliases}
  if manager.alias in aliases:
    client.update_collection_aliases(change_aliases_operations=[
      qmodels.DeleteAliasOperation(delete_alias=qmodels.DeleteAlias(alias_name=manager.alias))
    ])
  if client.collection_exists(name):
    client.delete_collection(collection_name=name)


def _read_seed(path: Path) -> bytes:
  if path.stat().st_mode & 0o077:
    raise ValueError("TASK-049 seed file must have mode 0600")
  try:
    seed = bytes.fromhex(path.read_text(encoding="utf-8").strip())
  except ValueError as error:
    raise ValueError("TASK-049 seed file must contain hexadecimal bytes") from error
  seed_commitment(seed)
  return seed


def run_calibration(
  *,
  repository_root: Path,
  seed_path: Path,
  policy_path: Path,
  output_path: Path,
  mongo_uri: str,
  qdrant_url: str,
  model_name: str,
  model_revision: str,
  device: str,
) -> dict:
  policy = json.loads(policy_path.read_text(encoding="utf-8"))
  seed = _read_seed(seed_path)
  if seed_commitment(seed) != policy["calibration_seed_sha256"]:
    raise ValueError("TASK-049 calibration seed commitment mismatch")
  dataset = generate_dataset(seed, split="calibration")
  prior_paths = [
    repository_root / "backend-ai" / "evaluation" / "retrieval-v1" / name
    for name in ("review-candidate-v1.jsonl", "review-candidate-v2.jsonl", "review-candidate-v3.jsonl")
  ]
  assert_no_query_overlap(dataset.cases, prior_paths)
  git_sha = subprocess.check_output(
    ["git", "rev-parse", "HEAD"], cwd=repository_root, text=True,
  ).strip()
  if subprocess.check_output(
    ["git", "status", "--porcelain"], cwd=repository_root, text=True,
  ).strip():
    raise ValueError("TASK-049 calibration requires a clean exact-SHA repository")
  if output_path.exists():
    raise ValueError("TASK-049 calibration output already exists")

  os.environ.setdefault("HF_HUB_OFFLINE", "1")
  os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
  model_started = perf_counter()
  embedding = SentenceTransformerEmbeddingProvider(
    model_name,
    revision=model_revision,
    version="bge-m3-v1",
    device=device,
  )
  model_load_seconds = perf_counter() - model_started
  suffix = uuid4().hex
  database_name = f"eisenhower_task049_calibration_{suffix}"
  collection_name = f"task049_calibration_{suffix}"
  alias = f"task049_calibration_active_{suffix}"
  mongo = MongoClient(mongo_uri, serverSelectionTimeoutMS=3_000)
  qdrant = QdrantClient(url=qdrant_url, timeout=20)
  manager = QdrantCollectionManager(
    qdrant, alias=alias, vector_size=len(embedding.embed(["dimension probe"])[0]),
  )
  cleanup = {"mongo_database_dropped": False, "qdrant_collection_deleted": False}
  mongo_ready = False
  collection_created = False
  result = None
  started = perf_counter()
  try:
    if mongo.admin.command("ping")["ok"] != 1.0:
      raise RuntimeError("isolated MongoDB is unavailable")
    mongo_ready = True
    qdrant_server = httpx.get(f"{qdrant_url.rstrip('/')}/", timeout=5).raise_for_status().json()
    manager.ensure_active(collection_name)
    collection_created = True
    store = MongoCanonicalDocumentStore(mongo[database_name].rag_documents)
    projection = QdrantIngestionAdapter(qdrant, collection_name=alias)
    chunker = DeterministicChunker(max_chars=1200, overlap_chars=160)
    ingestion = CanonicalIngestionApplication(embedding, store, projection, chunker)
    ingestion_result = ingestion.ingest(list(dataset.documents))
    if ingestion_result["accepted"] != len(dataset.documents) or ingestion_result["pending"] != 0:
      raise RuntimeError("TASK-049 synthetic corpus did not reach both stores")
    dense = CanonicalRetriever(
      QdrantRetriever(qdrant, embedding, collection_alias=alias),
      store,
      embedding_version=embedding.version,
      chunker=chunker,
    )
    lexical = CanonicalBm25Retriever(
      store,
      embedding_version=embedding.version,
      chunker=chunker,
      title_weight=2.0,
      text_weight=1.0,
    )
    candidates, configurations = build_candidates(dense, lexical)
    expected_configurations = policy["candidates"]
    if configurations != expected_configurations:
      raise ValueError("TASK-049 candidate configuration drifted from policy")
    confidence_diagnostics = []
    for case in dataset.cases:
      query = RetrievalQuery(
        text=case.task,
        scope=AccessScope(
          tenant_id=case.tenant_id,
          user_id=case.user_id,
          project_ids=case.project_ids,
          roles=case.roles,
        ),
        project_id=case.query_project_id,
        limit=20,
        score_threshold=-1.0,
      )
      dense_hits = dense.retrieve(query)
      lexical_hits = lexical.retrieve(query)
      confidence_diagnostics.append({
        "case_id": case.case_id,
        "language": case.language,
        "answerability": case.answerability,
        "category": next(
          tag.removeprefix("category:")
          for tag in case.tags
          if tag.startswith("category:")
        ),
        "relevant_document_ids": case.relevant_document_ids,
        "dense_document_ids": [hit.document_id for hit in dense_hits],
        "lexical_document_ids": [hit.document_id for hit in lexical_hits],
        **confidence_features(
          [(hit.document_id, hit.score) for hit in dense_hits],
          [(hit.document_id, hit.score) for hit in lexical_hits],
        ),
      })
    reports = {
      candidate_id: RetrievalGoldenRunner(candidate).run(list(dataset.cases), k=5)
      for candidate_id, candidate in candidates.items()
    }
    try:
      selected_candidate = select_candidate(reports, policy)
      selection_error = None
    except ValueError as error:
      selected_candidate = None
      selection_error = str(error)
    result = {
      "schema_version": "task049-calibration-v1",
      "evidence_scope": "synthetic_local_physical_candidate_calibration",
      "dataset_version": dataset.cases[0].dataset_version,
      "dataset_seed_sha256": seed_commitment(seed),
      "dataset_cases_sha256": sha256(serialize_cases(dataset.cases).encode("utf-8")).hexdigest(),
      "dataset_documents_sha256": sha256(
        serialize_documents(dataset.documents).encode("utf-8")
      ).hexdigest(),
      "policy_sha256": _digest(policy_path),
      "source_git_sha": git_sha,
      "source_git_dirty": False,
      "model": {
        "id": model_name,
        "revision": model_revision,
        "embedding_version": embedding.version,
        "device": device,
      },
      "runtime": {
        "qdrant_server_version": qdrant_server["version"],
        "qdrant_client_version": version("qdrant-client"),
        "pymongo_version": version("pymongo"),
        "model_load_seconds": round(model_load_seconds, 6),
        "process_peak_rss_mib": round(
          resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
          3,
        ),
      },
      "configurations": configurations,
      "confidence_diagnostics": confidence_diagnostics,
      "reports": reports,
      "selected_candidate": selected_candidate,
      "selection_error": selection_error,
      "total_seconds_before_cleanup": round(perf_counter() - started, 6),
      "cleanup": cleanup,
    }
  finally:
    if mongo_ready:
      mongo.drop_database(database_name)
      cleanup["mongo_database_dropped"] = True
    if collection_created:
      _delete_collection(qdrant, manager, collection_name)
      cleanup["qdrant_collection_deleted"] = True
    qdrant.close()
    mongo.close()
  if result is None or not all(cleanup.values()):
    raise RuntimeError("TASK-049 calibration did not finish with verified cleanup")
  output_path.parent.mkdir(parents=True, exist_ok=True)
  with output_path.open("x", encoding="utf-8") as output:
    json.dump(result, output, ensure_ascii=False, indent=2, sort_keys=True)
    output.write("\n")
  return result


def main() -> int:
  parser = argparse.ArgumentParser(description="Run exact-SHA TASK-049 BGE-M3 calibration.")
  parser.add_argument("--seed-file", type=Path, required=True)
  parser.add_argument("--policy", type=Path, required=True)
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument("--repository-root", type=Path, default=REPOSITORY_ROOT)
  parser.add_argument("--mongo-uri", default="mongodb://127.0.0.1:27017/?directConnection=true")
  parser.add_argument("--qdrant-url", default="http://127.0.0.1:6333")
  parser.add_argument("--model-name", default="BAAI/bge-m3")
  parser.add_argument("--model-revision", default="5617a9f61b028005a4858fdac845db406aefb181")
  parser.add_argument("--device", default="cuda")
  args = parser.parse_args()
  run_calibration(
    repository_root=args.repository_root.resolve(),
    seed_path=args.seed_file.resolve(),
    policy_path=args.policy.resolve(),
    output_path=args.output.resolve(),
    mongo_uri=args.mongo_uri,
    qdrant_url=args.qdrant_url,
    model_name=args.model_name,
    model_revision=args.model_revision,
    device=args.device,
  )
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
