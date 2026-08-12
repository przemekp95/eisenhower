"""Prove the local browser-to-governed-RAG path without mocking the API route.

The harness starts current Vite, Node and FastAPI sources, ingests the existing
frozen synthetic corpus through canonical Mongo into an isolated Qdrant alias,
and drives Chromium with the repository's manual Playwright scenario.  The
generation boundary is deliberately deterministic and test-only: this proof is
about the browser, transport, retrieval, ACL and citation path, not TASK-015 or
vLLM quality.
"""

from __future__ import annotations

# The harness owns several child processes and cleanup branches by design.
# pylint: disable=too-many-locals,too-many-statements,consider-using-with

import argparse
from hashlib import sha256
from hmac import compare_digest
from importlib.metadata import version
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import monotonic, sleep
from typing import Any
from uuid import uuid4

import httpx
from pymongo import MongoClient
from qdrant_client import QdrantClient, models as qmodels

from app.config import Settings
from app.auth import AuthError, AuthPrincipal
from app.generation.models import ClassificationOutput, Evidence, Fact, GenerationResult
from app.main import create_app
from app.rag.adapters import QdrantIngestionAdapter, QdrantRetriever
from app.rag.application import RagAnalysisService
from app.rag.canonical import CanonicalIngestionApplication
from app.rag.collections import QdrantCollectionManager
from app.rag.ingestion import DeterministicChunker
from app.rag.models import AccessScope, GenerationRequest, RetrievalQuery, SourceDocument
from app.rag.mongo_document_store import MongoCanonicalDocumentStore
from run_retrieval_candidate import PinnedMiniLMEmbedding


ROOT = Path(__file__).resolve().parents[2]
WEB_ROOT = ROOT / "web"
LIVE_SPEC = WEB_ROOT / "e2e" / "grounded-rag.live.manual.spec.ts"
LIVE_CONFIG = WEB_ROOT / "playwright.rag-live.config.ts"
RUNTIME_QUERY = "Raport musi zostać wysłany przed spotkaniem o 14:00; jest pilny i ważny."


class RuntimeProofClassifier:
  """Small deterministic fallback boundary; the successful proof does not use it."""

  @staticmethod
  def capabilities() -> dict[str, Any]:
    return {
      "classification": True,
      "knowledge_retrieval": True,
      "retrieval_augmented_generation": True,
      "model": {"generation_id": "task020-browser-runtime-proof"},
    }

  @staticmethod
  def classify_task(_task: str, use_rag: bool = False) -> dict[str, Any]:
    del use_rag
    return {
      "quadrant": 0,
      "quadrant_name": "Do Now",
      "confidence": 1.0,
    }


class RuntimeProofTokenVerifier:
  """Bind the browser token to the synthetic corpus identity, never request fields."""

  def __init__(self, user_token: str, admin_token: str):
    self.user_token = user_token
    self.admin_token = admin_token

  def verify(self, token: str) -> AuthPrincipal:
    if compare_digest(token, self.admin_token):
      return AuthPrincipal(
        "synthetic-a",
        "u1",
        roles=["admin"],
        project_ids=["p1"],
        scopes=["*"],
      )
    if compare_digest(token, self.user_token):
      return AuthPrincipal(
        "synthetic-a",
        "u1",
        roles=["user"],
        project_ids=["p1"],
        scopes=["ai:analyze"],
      )
    raise AuthError("Access denied")


class DeterministicGroundedGenerator:
  """Test-only generator that may cite only context supplied by real retrieval."""

  @staticmethod
  def generate(request: GenerationRequest) -> GenerationResult:
    if not request.context:
      raise RuntimeError("runtime proof generator requires retrieved context")
    hit = request.context[0]
    execution_payload = {
      "task": request.task,
      "chunk_ids": [item.chunk_id for item in request.context],
      "retrieval_version": request.retrieval_version,
      "index_version": request.index_version,
    }
    execution_id = sha256(
      json.dumps(execution_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return GenerationResult(
      output=ClassificationOutput(
        status="classified",
        urgent=True,
        important=True,
        quadrant=0,
        facts=[Fact(statement="The request asks for verifiable delivery evidence.", source="task")],
        evidence=[
          Evidence(
            statement="The frozen synthetic corpus says this report is urgent and important.",
            source="retrieved_context",
            chunk_id=hit.chunk_id,
          )
        ],
        citations=[hit.chunk_id],
        explanation="The frozen synthetic deadline evidence makes this task urgent and important.",
        confidence=0.91,
        no_answer_reason=None,
      ),
      execution_id=execution_id,
      prompt_id="task020-runtime-proof",
      prompt_version="1.0.0",
      language=request.language,
      model_id="deterministic-test-generator",
      model_revision=sha256(b"task020-deterministic-test-generator-v1").hexdigest(),
      schema_version="1.0.0",
      input_tokens=0,
      context_chunk_ids=[item.chunk_id for item in request.context],
    )


def _available_port() -> int:
  with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
    probe.bind(("127.0.0.1", 0))
    return int(probe.getsockname()[1])


def _wait_ready(
  url: str,
  process: subprocess.Popen,
  log_path: Path,
  timeout_seconds: float = 120,
) -> None:
  deadline = monotonic() + timeout_seconds
  while monotonic() < deadline:
    if process.poll() is not None:
      log = log_path.read_text(encoding="utf-8", errors="replace")[-6000:]
      raise RuntimeError(f"runtime process exited before readiness: {log}")
    try:
      if httpx.get(url, timeout=1).is_success:
        return
    except httpx.HTTPError:
      pass
    sleep(0.25)
  raise TimeoutError(f"runtime process did not become ready at {url}")


def _terminate(process: subprocess.Popen | None) -> None:
  if process is None or process.poll() is not None:
    return
  process.terminate()
  try:
    process.wait(timeout=10)
  except subprocess.TimeoutExpired:
    process.kill()
    process.wait(timeout=5)


def _port_closed(port: int) -> bool:
  with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
    probe.settimeout(0.2)
    return probe.connect_ex(("127.0.0.1", port)) != 0


def _delete_alias(client: QdrantClient, alias: str) -> None:
  aliases = {item.alias_name for item in client.get_aliases().aliases}
  if alias in aliases:
    client.update_collection_aliases(
      change_aliases_operations=[
        qmodels.DeleteAliasOperation(delete_alias=qmodels.DeleteAlias(alias_name=alias))
      ]
    )


def _source_sha256(paths: list[Path]) -> str:
  digest = sha256()
  files: list[Path] = []
  for path in paths:
    if path.is_file():
      files.append(path)
    elif path.is_dir():
      files.extend(item for item in path.rglob("*") if item.is_file())
  for path in sorted(set(files)):
    if "__pycache__" in path.parts or "node_modules" in path.parts or "output" in path.parts:
      continue
    digest.update(path.relative_to(ROOT).as_posix().encode("utf-8"))
    digest.update(b"\0")
    digest.update(path.read_bytes())
    digest.update(b"\0")
  return digest.hexdigest()


def build_runtime_app(args: argparse.Namespace):
  """Compose current FastAPI/RAG code with real Qdrant and a test generator."""
  settings = Settings(
    training_data_path=ROOT / "backend-ai" / "data" / "training_data.json",
    model_cache_dir=Path(args.model_cache_dir),
    app_env="development",
    auth_mode="static",
    api_token=args.user_token,
    admin_token=args.admin_token,
    rag_retrieval_enabled=True,
    rag_generation_enabled=True,
    rag_response_enabled=True,
    rag_allowed_tenants=("synthetic-a",),
    qdrant_url=args.qdrant_url,
    qdrant_collection_alias=args.qdrant_alias,
    embedding_version="minilm-v1",
    cors_allow_origins=(args.web_origin,),
  )
  embedding = PinnedMiniLMEmbedding(
    settings.local_model_name,
    settings.local_model_revision,
  )
  qdrant = QdrantClient(url=settings.qdrant_url, timeout=20)
  rag_service = RagAnalysisService(
    QdrantRetriever(qdrant, embedding, collection_alias=settings.qdrant_collection_alias),
    DeterministicGroundedGenerator(),
    RuntimeProofClassifier(),
    retrieval_version=settings.retrieval_version,
    index_version=settings.index_version,
  )
  return create_app(
    settings=settings,
    ai_service=RuntimeProofClassifier(),
    rag_service=rag_service,
    token_verifier=RuntimeProofTokenVerifier(args.user_token, args.admin_token),
  )


def serve_runtime(args: argparse.Namespace) -> None:
  """Run the bounded proof composition behind a real Uvicorn HTTP server."""
  import uvicorn

  uvicorn.run(
    build_runtime_app(args),
    host="127.0.0.1",
    port=args.port,
    workers=1,
    log_level="info",
  )


def run() -> dict[str, Any]:
  """Execute the isolated browser-to-RAG runtime proof."""
  suffix = uuid4().hex
  database_name = f"eisenhower_task020_browser_{suffix}"
  collection_name = f"task020_browser_{suffix}"
  alias = f"task020_browser_active_{suffix}"
  node_port, ai_port, web_port = (_available_port() for _ in range(3))
  web_origin = f"http://127.0.0.1:{web_port}"
  qdrant_url = "http://127.0.0.1:6333"
  user_token = f"task020-browser-user-{suffix}"
  admin_token = f"task020-browser-admin-{suffix}"
  corpus_path = ROOT / "backend-ai" / "evaluation" / "synthetic-corpus-v1.jsonl"
  mongo = MongoClient("mongodb://127.0.0.1:27017", serverSelectionTimeoutMS=3_000)
  qdrant = QdrantClient(url=qdrant_url, timeout=20)
  node_process = None
  ai_process = None
  web_process = None
  report = None
  cleanup = {
    "node_stopped": False,
    "fastapi_stopped": False,
    "vite_stopped": False,
    "ports_closed": False,
    "mongo_database_dropped": False,
    "qdrant_alias_deleted": False,
    "qdrant_collection_deleted": False,
    "temporary_browser_artifacts_removed": False,
  }

  settings = Settings(
    training_data_path=ROOT / "backend-ai" / "data" / "training_data.json",
    model_cache_dir=ROOT / "backend-ai" / "data" / "runtime",
  )
  embedding = PinnedMiniLMEmbedding(settings.local_model_name, settings.local_model_revision)
  vector_size = len(embedding.embed(["dimension probe"])[0])

  try:
    mongo.admin.command("ping")
    qdrant_runtime = httpx.get(qdrant_url, timeout=5).raise_for_status().json()
    QdrantCollectionManager(qdrant, alias=alias, vector_size=vector_size).ensure_active(
      collection_name
    )
    scope = AccessScope(
      tenant_id="synthetic-a",
      user_id="u1",
      project_ids=["p1"],
      roles=["user"],
    )
    documents = [
      SourceDocument.model_validate_json(line)
      for line in corpus_path.read_text(encoding="utf-8").splitlines()
      if line.strip()
    ]
    canonical_store = MongoCanonicalDocumentStore(mongo[database_name].rag_documents)
    ingestion = CanonicalIngestionApplication(
      embedding,
      canonical_store,
      QdrantIngestionAdapter(qdrant, collection_name=alias),
      DeterministicChunker(max_chars=1200, overlap_chars=160),
    )
    ingestion_result = ingestion.ingest(documents)
    reconciliation = {
      "synthetic-a/p1": ingestion.reconcile("synthetic-a", "p1"),
      "synthetic-b/p2": ingestion.reconcile("synthetic-b", "p2"),
    }
    if ingestion_result["accepted"] != len(documents) or ingestion_result["pending"] != 0:
      raise RuntimeError("frozen synthetic corpus did not reach both governed stores")
    clean_reconciliation = {"projected": 0, "pending": 0, "drifted": 0}
    if any(result != clean_reconciliation for result in reconciliation.values()):
      raise RuntimeError("frozen synthetic corpus projection did not reconcile cleanly")
    preflight_hits = QdrantRetriever(qdrant, embedding, collection_alias=alias).retrieve(
      RetrievalQuery(
        text=RUNTIME_QUERY,
        scope=scope,
        limit=6,
        score_threshold=0.2,
      )
    )
    if not preflight_hits:
      raise RuntimeError("real Qdrant retrieval returned no frozen synthetic evidence")
    if any(
      hit.tenant_id != "synthetic-a"
      or hit.project_id != "p1"
      or hit.source_uri.endswith("/deleted")
      for hit in preflight_hits
    ):
      raise RuntimeError("real Qdrant retrieval escaped the synthetic browser scope")
    wrong_user_hits = QdrantRetriever(qdrant, embedding, collection_alias=alias).retrieve(
      RetrievalQuery(
        text=RUNTIME_QUERY,
        scope=AccessScope(
          tenant_id="synthetic-a",
          user_id="intruder",
          roles=["user"],
        ),
        limit=6,
        score_threshold=0.2,
      )
    )
    if wrong_user_hits:
      raise RuntimeError("Qdrant ACL probe exposed synthetic evidence to a wrong user")

    with TemporaryDirectory(prefix="eisenhower-task020-browser-") as temporary:
      temporary_path = Path(temporary)
      evidence_dir = temporary_path / "browser-evidence"
      evidence_dir.mkdir()
      node_log = temporary_path / "node.log"
      ai_log = temporary_path / "ai.log"
      web_log = temporary_path / "vite.log"
      playwright_log = temporary_path / "playwright.log"
      model_cache_dir = temporary_path / "model-cache"
      ai_command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "serve",
        "--port",
        str(ai_port),
        "--qdrant-url",
        qdrant_url,
        "--qdrant-alias",
        alias,
        "--user-token",
        user_token,
        "--admin-token",
        admin_token,
        "--web-origin",
        web_origin,
        "--model-cache-dir",
        str(model_cache_dir),
      ]
      node_environment = {
        **os.environ,
        "NODE_ENV": "development",
        "AUTH_MODE": "static",
        "EISENHOWER_API_TOKEN": user_token,
        "MONGODB_URI": f"mongodb://127.0.0.1:27017/{database_name}",
        "AI_SERVICE_URL": f"http://127.0.0.1:{ai_port}",
        "CORS_ALLOW_ORIGINS": web_origin,
        "PORT": str(node_port),
      }
      web_environment = {
        **os.environ,
        "VITE_API_URL": f"http://127.0.0.1:{node_port}",
        "VITE_AI_API_URL": f"http://127.0.0.1:{ai_port}",
      }
      playwright_environment = {
        **os.environ,
        "PLAYWRIGHT_BASE_URL": web_origin,
        "LIVE_AI_API_URL": f"http://127.0.0.1:{ai_port}",
        "LIVE_ACCESS_TOKEN": user_token,
        "LIVE_ADMIN_TOKEN": admin_token,
        "LIVE_RAG_QUERY": RUNTIME_QUERY,
        "LIVE_EVIDENCE_DIR": str(evidence_dir),
        "PLAYWRIGHT_OUTPUT_DIR": str(temporary_path / "playwright-output"),
      }
      with ai_log.open("w", encoding="utf-8") as ai_output, node_log.open(
        "w", encoding="utf-8"
      ) as node_output, web_log.open("w", encoding="utf-8") as web_output:
        ai_process = subprocess.Popen(
          ai_command,
          cwd=ROOT,
          env={**os.environ, "PYTHONPATH": str(ROOT / "backend-ai")},
          stdout=ai_output,
          stderr=subprocess.STDOUT,
        )
        _wait_ready(f"http://127.0.0.1:{ai_port}/health/ready", ai_process, ai_log)
        node_process = subprocess.Popen(
          [str(ROOT / "backend-node" / "node_modules" / ".bin" / "tsx"), "src/server.ts"],
          cwd=ROOT / "backend-node",
          env=node_environment,
          stdout=node_output,
          stderr=subprocess.STDOUT,
        )
        _wait_ready(f"http://127.0.0.1:{node_port}/health", node_process, node_log)
        web_process = subprocess.Popen(
          [
            str(WEB_ROOT / "node_modules" / ".bin" / "vite"),
            "--host",
            "127.0.0.1",
            "--port",
            str(web_port),
            "--strictPort",
          ],
          cwd=WEB_ROOT,
          env=web_environment,
          stdout=web_output,
          stderr=subprocess.STDOUT,
        )
        _wait_ready(web_origin, web_process, web_log)
        with playwright_log.open("w", encoding="utf-8") as playwright_output:
          completed = subprocess.run(
            [
              "node",
              "scripts/runPlaywright.js",
              "test",
              "--config=playwright.rag-live.config.ts",
            ],
            cwd=WEB_ROOT,
            env=playwright_environment,
            stdout=playwright_output,
            stderr=subprocess.STDOUT,
            timeout=180,
            check=False,
          )
        if completed.returncode != 0:
          log = playwright_log.read_text(encoding="utf-8", errors="replace")[-10000:]
          raise RuntimeError(f"live browser proof failed:\n{log}")

        browser_results = [
          json.loads(path.read_text(encoding="utf-8"))
          for path in sorted(evidence_dir.glob("*.json"))
        ]
        expected_projects = {"desktop-chromium", "mobile-chromium"}
        if {item["project"] for item in browser_results} != expected_projects:
          raise RuntimeError("browser proof did not produce both desktop and mobile evidence")
        for result in browser_results:
          response = result["network"]["response"]
          if response["mode"] != "rag" or response["retrieval"]["hit_count"] < 1:
            raise RuntimeError("browser observed a non-grounded API response")
          if not response["citations"]:
            raise RuntimeError("browser observed a grounded response without citations")
          if any(
            not citation["source_uri"].startswith("eisenhower://projects/p1/")
            or citation["source_uri"].endswith("/deleted")
            for citation in response["citations"]
          ):
            raise RuntimeError("browser observed a citation outside the frozen synthetic scope")

        report = {
          "schema_version": "web-rag-browser-runtime-local-v1",
          "status": "local_runtime_verified_not_deployed",
          "source_identity": {
            "base_head": subprocess.check_output(
              ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
            ).strip(),
            "worktree_dirty": bool(
              subprocess.check_output(
                ["git", "status", "--porcelain"], cwd=ROOT, text=True
              ).strip()
            ),
            "script_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
            "live_spec_sha256": sha256(LIVE_SPEC.read_bytes()).hexdigest(),
            "live_config_sha256": sha256(LIVE_CONFIG.read_bytes()).hexdigest(),
            "synthetic_corpus_sha256": sha256(corpus_path.read_bytes()).hexdigest(),
            "web_source_sha256": _source_sha256([WEB_ROOT / "src", WEB_ROOT / "vite.config.ts"]),
            "api_client_source_sha256": _source_sha256([ROOT / "packages" / "api-client"]),
            "fastapi_source_sha256": _source_sha256(
              [ROOT / "backend-ai" / "app", ROOT / "backend-ai" / "main.py"]
            ),
            "node_source_sha256": _source_sha256([ROOT / "backend-node" / "src"]),
            "web_lock_sha256": sha256((WEB_ROOT / "package-lock.json").read_bytes()).hexdigest(),
            "python_requirements_sha256": sha256(
              (ROOT / "backend-ai" / "requirements.txt").read_bytes()
            ).hexdigest(),
          },
          "runtime": {
            "browser_driver": "Playwright Chromium over real browser network",
            "vite": "current TypeScript/React source",
            "node": "current TypeScript source via tsx",
            "fastapi": "current create_app and /v2/ai/analyze via one Uvicorn worker",
            "mongo": "real local isolated canonical database",
            "qdrant_version": qdrant_runtime["version"],
            "qdrant_commit": qdrant_runtime["commit"],
            "embedding_model": embedding.model_name,
            "embedding_revision": embedding.revision,
            "embedding_version": embedding.version,
            "vector_size": vector_size,
            "generation_boundary": "deterministic test-only provider over retrieved chunk IDs",
            "python": sys.version.split()[0],
            "node_version": subprocess.check_output(["node", "--version"], text=True).strip(),
            "playwright": json.loads(
              (WEB_ROOT / "node_modules" / "@playwright" / "test" / "package.json").read_text(
                encoding="utf-8"
              )
            )["version"],
            "pymongo": version("pymongo"),
            "qdrant_client": version("qdrant-client"),
            "sentence_transformers": version("sentence-transformers"),
          },
          "ingestion": ingestion_result,
          "reconciliation": reconciliation,
          "preflight": {
            "query": RUNTIME_QUERY,
            "hit_count": len(preflight_hits),
            "top_chunk_id": preflight_hits[0].chunk_id,
            "top_source_uri": preflight_hits[0].source_uri,
            "wrong_user_hit_count": len(wrong_user_hits),
          },
          "browser": {
            "projects": browser_results,
            "project_count": len(browser_results),
            "api_route_mocked": False,
            "desktop_and_mobile": True,
          },
          "evidence_boundaries": [
            "The existing frozen synthetic-corpus-v1 JSONL supplies the local corpus; no user or production data is ingested.",
            "A test-only token verifier binds bearer tokens to the corpus-owned synthetic-a/u1/p1 identity; request fields cannot expand scope.",
            "Chromium called the real Vite client and current FastAPI /v2/ai/analyze route over HTTP with no Playwright route interception.",
            "Mongo is the canonical store and Qdrant is the isolated projection; ingestion and reconciliation completed before browser execution.",
            "The deterministic test-only generation boundary proves citation plumbing but does not prove vLLM, model quality, prompt approval or TASK-015.",
            "TASK-013 human retrieval labels and thresholds are not evaluated by this proof.",
            "No deployment, public HTTPS, production traffic or publication is claimed.",
            "The dirty worktree is bound by source hashes and is not represented as the base HEAD alone.",
          ],
          "cleanup": cleanup,
        }
    cleanup["temporary_browser_artifacts_removed"] = not temporary_path.exists()
  finally:
    _terminate(web_process)
    cleanup["vite_stopped"] = web_process is None or web_process.poll() is not None
    _terminate(node_process)
    cleanup["node_stopped"] = node_process is None or node_process.poll() is not None
    _terminate(ai_process)
    cleanup["fastapi_stopped"] = ai_process is None or ai_process.poll() is not None
    cleanup["ports_closed"] = all(_port_closed(port) for port in (node_port, ai_port, web_port))
    mongo.drop_database(database_name)
    cleanup["mongo_database_dropped"] = database_name not in mongo.list_database_names()
    _delete_alias(qdrant, alias)
    cleanup["qdrant_alias_deleted"] = alias not in {
      item.alias_name for item in qdrant.get_aliases().aliases
    }
    if qdrant.collection_exists(collection_name):
      qdrant.delete_collection(collection_name=collection_name)
    cleanup["qdrant_collection_deleted"] = not qdrant.collection_exists(collection_name)
    qdrant.close()
    mongo.close()

  if report is None or not all(cleanup.values()):
    raise RuntimeError(f"browser runtime did not finish with verified cleanup: {cleanup}")
  return report


def _parser() -> argparse.ArgumentParser:
  parser = argparse.ArgumentParser()
  subparsers = parser.add_subparsers(dest="command", required=True)
  verify = subparsers.add_parser("verify")
  verify.add_argument("--output", type=Path, required=True)
  serve = subparsers.add_parser("serve")
  serve.add_argument("--port", type=int, required=True)
  serve.add_argument("--qdrant-url", required=True)
  serve.add_argument("--qdrant-alias", required=True)
  serve.add_argument("--user-token", required=True)
  serve.add_argument("--admin-token", required=True)
  serve.add_argument("--web-origin", required=True)
  serve.add_argument("--model-cache-dir", required=True)
  return parser


def main() -> None:
  args = _parser().parse_args()
  if args.command == "serve":
    serve_runtime(args)
    return
  report = run()
  args.output.parent.mkdir(parents=True, exist_ok=True)
  args.output.write_text(
    json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
    encoding="utf-8",
  )
  print(
    json.dumps(
      {
        "output": str(args.output),
        "sha256": sha256(args.output.read_bytes()).hexdigest(),
        "browser_projects": [item["project"] for item in report["browser"]["projects"]],
        "citation_counts": [
          len(item["network"]["response"]["citations"])
          for item in report["browser"]["projects"]
        ],
        "cleanup": report["cleanup"],
      },
      ensure_ascii=False,
      sort_keys=True,
    )
  )


if __name__ == "__main__":
  main()
