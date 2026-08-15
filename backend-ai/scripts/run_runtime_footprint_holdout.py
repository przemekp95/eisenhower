#!/usr/bin/env python3
from __future__ import annotations

import argparse
from hashlib import sha256
from importlib.metadata import version
import json
import os
from pathlib import Path
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

from app.config import Settings
from app.rag.adapters import QdrantIngestionAdapter, QdrantRetriever
from app.rag.canonical import CanonicalIngestionApplication, CanonicalRetriever
from app.rag.collections import QdrantCollectionManager
from app.rag.corpus_manifest import CorpusManifest, RepositoryCorpusConnector
from app.rag.golden import load_golden_dataset
from app.rag.golden_runner import RetrievalGoldenRunner
from app.rag.holdout_owner_acceptance import (
  EXPECTED_STRATEGY_IDS,
  HoldoutAcceptanceBlocked,
  HoldoutAcceptanceInputs,
  run_owner_accepted_holdout,
)
from app.rag.hybrid import CanonicalBm25Retriever, HybridRetriever
from app.rag.ingestion import DeterministicChunker
from app.rag.models import AccessScope
from app.rag.mongo_document_store import MongoCanonicalDocumentStore
from scripts.run_retrieval_candidate import PinnedMiniLMEmbedding, VllmScoreReranker


FROZEN_CONFIGURATION = {
  "rrf_k": 20,
  "title_weight": 2.0,
  "text_weight": 1.0,
  "dense_rrf_weight": 1.0,
  "lexical_rrf_weight": 2.0,
  "candidate_multiplier": 4,
  "reranker_candidate_limit": 20,
  "reranker_weight": 1.0,
  "reranker_model": "BAAI/bge-reranker-v2-m3",
  "reranker_revision": "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e",
  "reranker_max_tokens": 192,
}


def _load_frozen_configuration(strategy_reports: dict[str, Path]) -> dict:
  configurations = {}
  for name, path in strategy_reports.items():
    try:
      report = json.loads(path.read_text(encoding="utf-8"))
      configurations[name] = report["train_selection"]["selected_configuration"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as issue:
      raise HoldoutAcceptanceBlocked(f"frozen strategy report is invalid: {name}") from issue
  if set(configurations) != set(EXPECTED_STRATEGY_IDS):
    raise HoldoutAcceptanceBlocked("frozen strategy report set is invalid")
  if any(configuration != FROZEN_CONFIGURATION for configuration in configurations.values()):
    raise HoldoutAcceptanceBlocked("frozen strategy configuration drifted")
  return dict(FROZEN_CONFIGURATION)


def _delete_collection(client: QdrantClient, manager: QdrantCollectionManager, name: str) -> None:
  aliases = {item.alias_name for item in client.get_aliases().aliases}
  if manager.alias in aliases:
    client.update_collection_aliases(change_aliases_operations=[
      qmodels.DeleteAliasOperation(delete_alias=qmodels.DeleteAlias(alias_name=manager.alias))
    ])
  if client.collection_exists(name):
    client.delete_collection(collection_name=name)


def _build_retrievers(store, dense_retriever, reranker, configuration: dict):
  chunker = DeterministicChunker(max_chars=1200, overlap_chars=160)

  def lexical():
    return CanonicalBm25Retriever(
      store,
      embedding_version="minilm-v1",
      chunker=chunker,
      title_weight=configuration["title_weight"],
      text_weight=configuration["text_weight"],
    )

  common = {
    "rrf_k": configuration["rrf_k"],
    "dense_rrf_weight": configuration["dense_rrf_weight"],
    "lexical_rrf_weight": configuration["lexical_rrf_weight"],
    "candidate_multiplier": configuration["candidate_multiplier"],
  }
  no_reranker = HybridRetriever(dense_retriever, lexical(), **common)
  with_reranker = HybridRetriever(
    dense_retriever,
    lexical(),
    **common,
    reranker=reranker,
    reranker_candidate_limit=configuration["reranker_candidate_limit"],
    reranker_weight=configuration["reranker_weight"],
  )
  return {
    "hybrid_reranker": with_reranker,
    "hybrid_no_reranker": no_reranker,
  }


def run_frozen_holdout(
  *,
  inputs: HoldoutAcceptanceInputs,
  repository_root: Path,
  mongo_uri: str,
  qdrant_url: str,
  reranker_url: str,
  reranker_api_key: str,
) -> dict:
  configuration = _load_frozen_configuration(inputs.strategy_reports)
  cases = load_golden_dataset(inputs.candidate)
  holdout = [case for case in cases if case.split == "holdout"]
  if len(holdout) != 6 or {case.language for case in holdout} != {"pl", "en"}:
    raise HoldoutAcceptanceBlocked("frozen holdout must contain the six PL/EN cases")
  manifest = CorpusManifest.load(inputs.corpus_manifest)
  settings = Settings(
    training_data_path=repository_root / "data" / "training.jsonl",
    model_cache_dir=repository_root / "data" / "models",
  )
  embedding = PinnedMiniLMEmbedding(settings.local_model_name, settings.local_model_revision)
  reranker = VllmScoreReranker(reranker_url, reranker_api_key)
  if reranker.max_model_len != configuration["reranker_max_tokens"]:
    raise HoldoutAcceptanceBlocked("reranker context differs from the frozen configuration")

  suffix = uuid4().hex
  database_name = f"eisenhower_task048_holdout_{suffix}"
  collection_name = f"task048_holdout_{suffix}"
  alias = f"task048_holdout_active_{suffix}"
  mongo = MongoClient(mongo_uri, serverSelectionTimeoutMS=3_000)
  qdrant = QdrantClient(url=qdrant_url, timeout=20)
  manager = QdrantCollectionManager(
    qdrant, alias=alias, vector_size=len(embedding.embed(["dimension probe"])[0]),
  )
  cleanup = {"mongo_database_dropped": False, "qdrant_collection_deleted": False}
  mongo_ready = False
  collection_created = False
  comparison = None
  started = perf_counter()
  try:
    if mongo.admin.command("ping")["ok"] != 1.0:
      raise RuntimeError("isolated MongoDB is unavailable")
    mongo_ready = True
    qdrant_server = httpx.get(f"{qdrant_url.rstrip('/')}/", timeout=5).raise_for_status().json()
    collection_created = True
    manager.ensure_active(collection_name)
    scope = AccessScope(
      tenant_id="eisenhower-owner", user_id="eisenhower-owner", project_ids=["eisenhower"],
    )
    documents = RepositoryCorpusConnector(repository_root, manifest).load_initial(scope)
    store = MongoCanonicalDocumentStore(mongo[database_name].rag_documents)
    projection = QdrantIngestionAdapter(qdrant, collection_name=alias)
    chunker = DeterministicChunker(max_chars=1200, overlap_chars=160)
    ingestion = CanonicalIngestionApplication(embedding, store, projection, chunker)
    ingestion_result = ingestion.ingest(documents)
    reconciliation = ingestion.reconcile(scope.tenant_id, "eisenhower")
    if ingestion_result["accepted"] != len(documents) or ingestion_result["pending"] != 0:
      raise RuntimeError("holdout corpus did not reach both stores")
    if reconciliation != {"projected": 0, "pending": 0, "drifted": 0}:
      raise RuntimeError("holdout corpus projection did not reconcile")
    dense = CanonicalRetriever(
      QdrantRetriever(qdrant, embedding, collection_alias=alias),
      store,
      embedding_version=embedding.version,
      chunker=chunker,
    )
    retrievers = _build_retrievers(store, dense, reranker, configuration)
    strategy_results = {
      name: RetrievalGoldenRunner(candidate).run(holdout, k=5)
      for name, candidate in retrievers.items()
    }
    comparison = {
      "schema_version": "retrieval-runtime-footprint-holdout-v1",
      "dataset_version": holdout[0].dataset_version,
      "evaluated_split": "holdout",
      "case_ids": [case.case_id for case in holdout],
      "tuning_performed": False,
      "strategies": strategy_results,
      "configuration": configuration,
      "model": {
        "id": embedding.model_name,
        "revision": embedding.revision,
        "embedding_version": embedding.version,
      },
      "runtime": {
        "qdrant_server_version": qdrant_server["version"],
        "qdrant_client_version": version("qdrant-client"),
        "pymongo_version": version("pymongo"),
      },
      "source_git_sha": subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=repository_root, text=True,
      ).strip(),
      "source_git_dirty": bool(subprocess.check_output(
        ["git", "status", "--porcelain"], cwd=repository_root, text=True,
      ).strip()),
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
  if comparison is None or not all(cleanup.values()):
    raise RuntimeError("holdout comparison did not finish with verified cleanup")
  return comparison


def main() -> int:
  evaluation_root = PROJECT_ROOT / "evaluation" / "retrieval-v1"
  parser = argparse.ArgumentParser(
    description="Run the exact TASK-048 strategy pair once on the owner-accepted frozen holdout."
  )
  parser.add_argument(
    "--acceptance", type=Path,
    default=evaluation_root / "runtime-footprint-holdout-owner-acceptance-v1.json",
  )
  parser.add_argument("--candidate", type=Path, default=evaluation_root / "review-candidate-v3.jsonl")
  parser.add_argument(
    "--thresholds", type=Path, default=evaluation_root / "review-candidate-v1-thresholds.json",
  )
  parser.add_argument(
    "--corpus-manifest", type=Path,
    default=REPOSITORY_ROOT / "docs" / "ai-rebuild" / "corpus-manifest-v1.json",
  )
  parser.add_argument(
    "--hybrid-report", type=Path,
    default=evaluation_root / "dense-hybrid-reranker-gpu192-v3-20260812.json",
  )
  parser.add_argument(
    "--no-reranker-report", type=Path,
    default=evaluation_root / "runtime-footprint-no-reranker-v1.json",
  )
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument("--repository-root", type=Path, default=REPOSITORY_ROOT)
  parser.add_argument("--mongo-uri", default="mongodb://127.0.0.1:27017/?directConnection=true")
  parser.add_argument("--qdrant-url", default="http://127.0.0.1:6333")
  parser.add_argument("--reranker-url", required=True)
  parser.add_argument(
    "--reranker-api-key-env", default="RERANKER_API_KEY",
    help="Environment variable containing the private reranker Bearer secret.",
  )
  args = parser.parse_args()
  source_git_sha = subprocess.check_output(
    ["git", "rev-parse", "HEAD"], cwd=args.repository_root, text=True,
  ).strip()
  allowed_untracked = {
    args.acceptance.resolve(),
    args.output.resolve(),
    args.acceptance.with_name(
      f"{args.acceptance.name}.{sha256(args.acceptance.read_bytes()).hexdigest()}.used"
    ).resolve(),
  }
  status = subprocess.check_output(
    ["git", "status", "--porcelain", "--untracked-files=all"],
    cwd=args.repository_root, text=True,
  )
  unexpected = []
  for line in status.splitlines():
    candidate = (args.repository_root / line[3:]).resolve()
    if candidate not in allowed_untracked:
      unexpected.append(line)
  if unexpected:
    print("runtime-footprint-holdout-blocked: source git worktree is dirty", file=sys.stderr)
    return 2
  reranker_api_key = os.environ.get(args.reranker_api_key_env, "")
  if not reranker_api_key:
    print("runtime-footprint-holdout-blocked: reranker API key environment is empty", file=sys.stderr)
    return 2
  inputs = HoldoutAcceptanceInputs(
    candidate=args.candidate,
    thresholds=args.thresholds,
    corpus_manifest=args.corpus_manifest,
    strategy_reports={
      "hybrid_reranker": args.hybrid_report,
      "hybrid_no_reranker": args.no_reranker_report,
    },
    source_git_sha=source_git_sha,
  )
  try:
    report = run_owner_accepted_holdout(
      args.acceptance,
      inputs=inputs,
      output=args.output,
      evaluator=lambda: run_frozen_holdout(
        inputs=inputs,
        repository_root=args.repository_root.resolve(),
        mongo_uri=args.mongo_uri,
        qdrant_url=args.qdrant_url,
        reranker_url=args.reranker_url,
        reranker_api_key=reranker_api_key,
      ),
    )
  except (HoldoutAcceptanceBlocked, OSError, RuntimeError, ValueError) as issue:
    print(f"runtime-footprint-holdout-blocked: {issue}", file=sys.stderr)
    return 2
  print(json.dumps({
    "output": str(args.output),
    "sha256": sha256(args.output.read_bytes()).hexdigest(),
    "metrics": {
      name: result["metrics"] for name, result in report["strategies"].items()
    },
    "cleanup": report["cleanup"],
  }, ensure_ascii=False, sort_keys=True))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
