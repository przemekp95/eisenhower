#!/usr/bin/env python3
from __future__ import annotations

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys
from time import perf_counter
from uuid import uuid4

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
from app.rag.bge_m3_sparse import (
  BgeM3SparseEmbeddingProvider,
  QdrantSparseIngestionAdapter,
  QdrantSparseRetriever,
)
from app.rag.canonical import CanonicalIngestionApplication, CanonicalRetriever
from app.rag.collections import QdrantCollectionManager
from app.rag.hybrid import CanonicalBm25Retriever
from app.rag.ingestion import DeterministicChunker, build_chunk_records
from app.rag.models import AccessScope, RetrievalQuery
from app.rag.mongo_document_store import MongoCanonicalDocumentStore
from app.rag.task049_evaluation import (
  confidence_features,
  generate_dataset,
  seed_commitment,
  serialize_cases,
  serialize_documents,
)
from scripts.run_task049_calibration import _delete_collection, _read_seed


def run_diagnostics(args) -> dict:
  policy = json.loads(args.policy.read_text(encoding="utf-8"))
  seed = _read_seed(args.seed_file)
  if seed_commitment(seed) != policy["calibration_seed_sha256"]:
    raise ValueError("TASK-049 sparse diagnostic seed commitment mismatch")
  if sha256(args.sparse_artifact.read_bytes()).hexdigest() != args.sparse_artifact_sha256:
    raise ValueError("TASK-049 sparse artifact hash mismatch")
  git_sha = subprocess.check_output(
    ["git", "rev-parse", "HEAD"], cwd=args.repository_root, text=True,
  ).strip()
  if subprocess.check_output(
    ["git", "status", "--porcelain"], cwd=args.repository_root, text=True,
  ).strip():
    raise ValueError("TASK-049 sparse diagnostics require a clean exact-SHA repository")
  if args.output.exists():
    raise ValueError("TASK-049 sparse diagnostic output already exists")

  dataset = generate_dataset(seed, split="calibration")
  os.environ.setdefault("HF_HUB_OFFLINE", "1")
  os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
  started = perf_counter()
  dense_embedding = SentenceTransformerEmbeddingProvider(
    args.model_name,
    revision=args.model_revision,
    version="bge-m3-v1",
    device=args.device,
  )
  sparse_embedding = BgeM3SparseEmbeddingProvider(
    dense_embedding.model,
    artifact_path=args.sparse_artifact,
    artifact_sha256=args.sparse_artifact_sha256,
    version=dense_embedding.version,
  )
  model_load_seconds = perf_counter() - started
  suffix = uuid4().hex
  database_name = f"eisenhower_task049_sparse_{suffix}"
  dense_collection = f"task049_sparse_dense_{suffix}"
  dense_alias = f"task049_sparse_dense_active_{suffix}"
  sparse_collection = f"task049_sparse_projection_v1_{suffix}"
  sparse_alias = f"task049_sparse_active_{suffix}"
  sparse_vector_name = "bge-m3-sparse-v1"
  mongo = MongoClient(args.mongo_uri, serverSelectionTimeoutMS=3_000)
  qdrant = QdrantClient(url=args.qdrant_url, timeout=30)
  dense_manager = QdrantCollectionManager(
    qdrant,
    alias=dense_alias,
    vector_size=len(dense_embedding.embed(["dimension probe"])[0]),
  )
  cleanup = {
    "mongo_database_dropped": False,
    "dense_collection_deleted": False,
    "sparse_collection_deleted": False,
  }
  result = None
  try:
    mongo.admin.command("ping")
    dense_manager.ensure_active(dense_collection)
    qdrant.create_collection(
      collection_name=sparse_collection,
      vectors_config={},
      sparse_vectors_config={
        sparse_vector_name: qmodels.SparseVectorParams(
          index=qmodels.SparseIndexParams(on_disk=False),
        ),
      },
    )
    qdrant.update_collection_aliases(change_aliases_operations=[
      qmodels.CreateAliasOperation(create_alias=qmodels.CreateAlias(
        collection_name=sparse_collection,
        alias_name=sparse_alias,
      )),
    ])
    store = MongoCanonicalDocumentStore(mongo[database_name].rag_documents)
    chunker = DeterministicChunker(max_chars=1200, overlap_chars=160)
    ingestion = CanonicalIngestionApplication(
      dense_embedding,
      store,
      QdrantIngestionAdapter(qdrant, collection_name=dense_alias),
      chunker,
    )
    ingestion_result = ingestion.ingest(list(dataset.documents))
    if ingestion_result["pending"] != 0:
      raise RuntimeError("TASK-049 dense projection remained pending")
    chunks = [
      chunk
      for document in dataset.documents
      for chunk in build_chunk_records(
        document, chunker, embedding_version=dense_embedding.version,
      )
    ]
    sparse_vectors = sparse_embedding.embed_sparse([chunk.text for chunk in chunks])
    QdrantSparseIngestionAdapter(
      qdrant,
      collection_name=sparse_alias,
      vector_name=sparse_vector_name,
    ).replace_documents(list(dataset.documents), chunks, sparse_vectors)
    dense = CanonicalRetriever(
      QdrantRetriever(qdrant, dense_embedding, collection_alias=dense_alias),
      store,
      embedding_version=dense_embedding.version,
      chunker=chunker,
    )
    sparse = CanonicalRetriever(
      QdrantSparseRetriever(
        qdrant,
        sparse_embedding,
        collection_alias=sparse_alias,
        vector_name=sparse_vector_name,
      ),
      store,
      embedding_version=dense_embedding.version,
      chunker=chunker,
    )
    lexical = CanonicalBm25Retriever(
      store,
      embedding_version=dense_embedding.version,
      chunker=chunker,
      title_weight=2.0,
      text_weight=1.0,
    )
    rows = []
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
      sparse_hits = sparse.retrieve(query)
      rows.append({
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
        "sparse_document_ids": [hit.document_id for hit in sparse_hits],
        **confidence_features(
          [(hit.document_id, hit.score) for hit in dense_hits],
          [(hit.document_id, hit.score) for hit in lexical_hits],
        ),
        "sparse_top": sparse_hits[0].score if sparse_hits else None,
        "sparse_margin": (
          sparse_hits[0].score - sparse_hits[1].score
          if len(sparse_hits) > 1 else sparse_hits[0].score if sparse_hits else None
        ),
        "dense_sparse_agreement": bool(
          dense_hits and sparse_hits and dense_hits[0].document_id == sparse_hits[0].document_id
        ),
      })
    result = {
      "schema_version": "task049-sparse-diagnostics-v1",
      "evidence_scope": "synthetic_local_physical_calibration_only",
      "source_git_sha": git_sha,
      "policy_sha256": sha256(args.policy.read_bytes()).hexdigest(),
      "dataset_seed_sha256": seed_commitment(seed),
      "dataset_cases_sha256": sha256(serialize_cases(dataset.cases).encode()).hexdigest(),
      "dataset_documents_sha256": sha256(
        serialize_documents(dataset.documents).encode()
      ).hexdigest(),
      "model": {
        "id": args.model_name,
        "revision": args.model_revision,
        "sparse_artifact_sha256": args.sparse_artifact_sha256,
      },
      "runtime": {"device": args.device, "model_load_seconds": round(model_load_seconds, 6)},
      "collection": {
        "name": sparse_collection,
        "alias": sparse_alias,
        "vector_name": sparse_vector_name,
      },
      "rows": rows,
      "cleanup": cleanup,
    }
  finally:
    mongo.drop_database(database_name)
    cleanup["mongo_database_dropped"] = True
    _delete_collection(qdrant, dense_manager, dense_collection)
    cleanup["dense_collection_deleted"] = True
    aliases = {item.alias_name for item in qdrant.get_aliases().aliases}
    if sparse_alias in aliases:
      qdrant.update_collection_aliases(change_aliases_operations=[
        qmodels.DeleteAliasOperation(delete_alias=qmodels.DeleteAlias(alias_name=sparse_alias)),
      ])
    if qdrant.collection_exists(sparse_collection):
      qdrant.delete_collection(sparse_collection)
    cleanup["sparse_collection_deleted"] = True
    qdrant.close()
    mongo.close()
  if result is None or not all(cleanup.values()):
    raise RuntimeError("TASK-049 sparse diagnostics failed verified cleanup")
  args.output.parent.mkdir(parents=True, exist_ok=True)
  with args.output.open("x", encoding="utf-8") as output:
    json.dump(result, output, ensure_ascii=False, indent=2, sort_keys=True)
    output.write("\n")
  return result


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--seed-file", type=Path, required=True)
  parser.add_argument("--policy", type=Path, required=True)
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument("--sparse-artifact", type=Path, required=True)
  parser.add_argument("--sparse-artifact-sha256", required=True)
  parser.add_argument("--repository-root", type=Path, default=REPOSITORY_ROOT)
  parser.add_argument("--mongo-uri", default="mongodb://127.0.0.1:27017/?directConnection=true")
  parser.add_argument("--qdrant-url", default="http://127.0.0.1:6333")
  parser.add_argument("--model-name", default="BAAI/bge-m3")
  parser.add_argument("--model-revision", default="5617a9f61b028005a4858fdac845db406aefb181")
  parser.add_argument("--device", default="cuda")
  args = parser.parse_args()
  for name in ("seed_file", "policy", "output", "sparse_artifact", "repository_root"):
    setattr(args, name, getattr(args, name).resolve())
  run_diagnostics(args)
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
