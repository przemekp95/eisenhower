"""Verify the local MCP path against real Node, FastAPI, Mongo and Qdrant."""

from __future__ import annotations

# This orchestration script owns long-lived child processes across cleanup paths.
# pylint: disable=too-many-locals,too-many-statements,consider-using-with

import argparse
import asyncio
from hashlib import sha256
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
from app.rag.adapters import QdrantIngestionAdapter
from app.rag.canonical import CanonicalIngestionApplication
from app.rag.collections import QdrantCollectionManager
from app.rag.corpus_manifest import CorpusManifest, RepositoryCorpusConnector
from app.rag.ingestion import DeterministicChunker
from app.rag.models import AccessScope
from app.rag.mongo_document_store import MongoCanonicalDocumentStore
from run_retrieval_candidate import PinnedMiniLMEmbedding
from mcp.client import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


ROOT = Path(__file__).resolve().parents[2]
MCP_ROOT = ROOT / "mcp" / "eisenhower_adapter"


def _available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _delete_alias(client: QdrantClient, alias: str) -> None:
    aliases = {item.alias_name for item in client.get_aliases().aliases}
    if alias in aliases:
        client.update_collection_aliases(
            change_aliases_operations=[
                qmodels.DeleteAliasOperation(
                    delete_alias=qmodels.DeleteAlias(alias_name=alias)
                )
            ]
        )


def _wait_ready(
    url: str, process: subprocess.Popen, log_path: Path, timeout_seconds: float = 90
) -> None:
    deadline = monotonic() + timeout_seconds
    while monotonic() < deadline:
        if process.poll() is not None:
            log = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
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


def _source_sha256(paths: list[Path]) -> str:
    digest = sha256()
    files: list[Path] = []
    for path in paths:
        files.extend(item for item in path.rglob("*") if item.is_file())
        if path.is_file():
            files.append(path)
    for path in sorted(files):
        if "__pycache__" in path.parts:
            continue
        digest.update(path.relative_to(ROOT).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _tool_json(result) -> dict[str, Any]:
    if result.is_error:
        raise RuntimeError("MCP tool unexpectedly failed")
    return json.loads(result.content[0].text)


async def _call_runtime(
    server: StdioServerParameters,
    log_path: Path,
    task_id: str,
    project_id: str,
    wrong_project_id: str,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    calls = {
        "matrix_summary": {},
        "tasks_search": {"query": "runtime", "limit": 10},
        "task_get": {"task_id": task_id},
        "project_context": {"project_id": project_id, "limit": 10},
        "knowledge_search": {
            "query": "What evidence separates local tests from production acceptance?",
            "project_id": project_id,
            "limit": 5,
        },
        "priority_explain": {"task_id": task_id},
    }
    with log_path.open("w", encoding="utf-8") as error_log:
        async with stdio_client(server, errlog=error_log) as (
            read_stream,
            write_stream,
        ):
            async with ClientSession(
                read_stream, write_stream, read_timeout_seconds=15
            ) as session:
                await session.initialize()
                results = {
                    name: _tool_json(await session.call_tool(name, arguments))
                    for name, arguments in calls.items()
                }
                wrong_project = _tool_json(
                    await session.call_tool(
                        "knowledge_search",
                        {
                            "query": "production acceptance evidence",
                            "project_id": wrong_project_id,
                            "limit": 5,
                        },
                    )
                )
    return results, wrong_project


def run() -> dict[str, Any]:
    """Run the isolated full local runtime proof and return its evidence report."""
    suffix = uuid4().hex
    database_name = f"eisenhower_task020_mcp_{suffix}"
    collection_name = f"task020_mcp_{suffix}"
    alias = f"task020_mcp_active_{suffix}"
    project_id = f"task020-demo-{suffix}"
    node_port = _available_port()
    ai_port = _available_port()
    admin_token = f"task020-admin-{suffix}"
    user_token = f"task020-user-{suffix}"
    manifest_path = ROOT / "docs" / "ai-rebuild" / "corpus-manifest-v1.json"
    manifest = CorpusManifest.load(manifest_path)
    mongo = MongoClient("mongodb://127.0.0.1:27017", serverSelectionTimeoutMS=3_000)
    qdrant = QdrantClient(url="http://127.0.0.1:6333", timeout=20)
    node_process = None
    ai_process = None
    cleanup = {
        "node_stopped": False,
        "fastapi_stopped": False,
        "ports_closed": False,
        "mongo_database_dropped": False,
        "qdrant_alias_deleted": False,
        "qdrant_collection_deleted": False,
        "mcp_stdio_closed": False,
    }
    report = None

    settings = Settings(
        training_data_path=ROOT / "backend-ai" / "data" / "training_data.json",
        model_cache_dir=ROOT / "backend-ai" / "data" / "runtime",
    )
    embedding = PinnedMiniLMEmbedding(
        settings.local_model_name, settings.local_model_revision
    )
    vector_size = len(embedding.embed(["dimension probe"])[0])

    try:
        mongo.admin.command("ping")
        qdrant_runtime = (
            httpx.get("http://127.0.0.1:6333/", timeout=5).raise_for_status().json()
        )
        QdrantCollectionManager(
            qdrant, alias=alias, vector_size=vector_size
        ).ensure_active(collection_name)
        scope = AccessScope(
            tenant_id="local",
            user_id="local-admin",
            project_ids=[project_id],
            roles=["admin"],
        )
        documents = RepositoryCorpusConnector(ROOT, manifest).load_initial(scope)
        canonical_store = MongoCanonicalDocumentStore(
            mongo[database_name].rag_documents
        )
        ingestion = CanonicalIngestionApplication(
            embedding,
            canonical_store,
            QdrantIngestionAdapter(qdrant, collection_name=alias),
            DeterministicChunker(max_chars=1200, overlap_chars=160),
        )
        ingestion_result = ingestion.ingest(documents)
        reconciliation = ingestion.reconcile("local", project_id)
        if (
            ingestion_result["accepted"] != len(documents)
            or ingestion_result["pending"] != 0
        ):
            raise RuntimeError(
                "demo corpus did not reach canonical and projection stores"
            )
        if reconciliation != {"projected": 0, "pending": 0, "drifted": 0}:
            raise RuntimeError("demo projection did not reconcile cleanly")

        tasks = mongo[database_name].tasks
        seeded = tasks.insert_many(
            [
                {
                    "tenantId": "local",
                    "ownerId": "local-user",
                    "projectId": project_id,
                    "title": "Verify runtime evidence",
                    "description": "Exercise the local MCP demo path.",
                    "urgent": True,
                    "important": True,
                },
                {
                    "tenantId": "local",
                    "ownerId": "local-user",
                    "projectId": project_id,
                    "title": "Document runtime limitations",
                    "description": "Keep local, deployed and public proof separate.",
                    "urgent": False,
                    "important": True,
                },
            ]
        )
        task_id = str(seeded.inserted_ids[0])

        with TemporaryDirectory(prefix="eisenhower-task020-") as temporary:
            temporary_path = Path(temporary)
            node_log = temporary_path / "node.log"
            ai_log = temporary_path / "ai.log"
            mcp_log = temporary_path / "mcp.log"
            node_environment = {
                **os.environ,
                "NODE_ENV": "development",
                "AUTH_MODE": "static",
                "EISENHOWER_API_TOKEN": admin_token,
                "MONGODB_URI": f"mongodb://127.0.0.1:27017/{database_name}",
                "AI_SERVICE_URL": f"http://127.0.0.1:{ai_port}",
                "PORT": str(node_port),
            }
            ai_environment = {
                **os.environ,
                "PYTHONPATH": str(ROOT / "backend-ai"),
                "APP_ENV": "development",
                "AUTH_MODE": "static",
                "EISENHOWER_API_TOKEN": user_token,
                "EISENHOWER_ADMIN_TOKEN": admin_token,
                "RAG_ENABLED": "true",
                "RAG_RETRIEVAL_ENABLED": "true",
                "RAG_GENERATION_ENABLED": "false",
                "RAG_RESPONSE_ENABLED": "false",
                "QDRANT_URL": "http://127.0.0.1:6333",
                "QDRANT_COLLECTION_ALIAS": alias,
            }
            with node_log.open("w", encoding="utf-8") as node_output, ai_log.open(
                "w", encoding="utf-8"
            ) as ai_output:
                node_process = subprocess.Popen(
                    [
                        str(ROOT / "backend-node" / "node_modules" / ".bin" / "tsx"),
                        "src/server.ts",
                    ],
                    cwd=ROOT / "backend-node",
                    env=node_environment,
                    stdout=node_output,
                    stderr=subprocess.STDOUT,
                )
                ai_process = subprocess.Popen(
                    [
                        sys.executable,
                        "-m",
                        "uvicorn",
                        "main:app",
                        "--host",
                        "127.0.0.1",
                        "--port",
                        str(ai_port),
                        "--workers",
                        "1",
                    ],
                    cwd=ROOT / "backend-ai",
                    env=ai_environment,
                    stdout=ai_output,
                    stderr=subprocess.STDOUT,
                )
                _wait_ready(
                    f"http://127.0.0.1:{node_port}/health", node_process, node_log
                )
                _wait_ready(
                    f"http://127.0.0.1:{ai_port}/health/ready", ai_process, ai_log
                )

                mcp_parameters = StdioServerParameters(
                    command=sys.executable,
                    args=["-m", "eisenhower_mcp.server"],
                    cwd=MCP_ROOT,
                    env={
                        "MCP_TRANSPORT": "stdio",
                        "EISENHOWER_TASK_API_BASE_URL": (
                            f"http://127.0.0.1:{node_port}"
                        ),
                        "EISENHOWER_AI_API_BASE_URL": f"http://127.0.0.1:{ai_port}",
                        "EISENHOWER_API_TOKEN": admin_token,
                        "EISENHOWER_API_TIMEOUT_SECONDS": "10",
                    },
                )
                results, wrong_project = asyncio.run(
                    _call_runtime(
                        mcp_parameters,
                        mcp_log,
                        task_id,
                        project_id,
                        f"outside-{suffix}",
                    )
                )
                cleanup["mcp_stdio_closed"] = True

                citations = results["knowledge_search"]["citations"]
                if (
                    not citations
                    or results["knowledge_search"]["retrieval"]["hit_count"] < 1
                ):
                    raise RuntimeError(
                        "real FastAPI/Qdrant knowledge search returned no evidence"
                    )
                if any(
                    not citation["source_uri"].startswith("eisenhower://repository/")
                    for citation in citations
                ):
                    raise RuntimeError(
                        "knowledge search returned a source outside the frozen repository corpus"
                    )
                if (
                    wrong_project["citations"]
                    or wrong_project["retrieval"]["hit_count"] != 0
                ):
                    raise RuntimeError(
                        "project isolation probe returned knowledge hits"
                    )
                if results["matrix_summary"]["total"] != 2:
                    raise RuntimeError(
                        "real Node task API did not return the isolated demo tasks"
                    )
                if results["task_get"]["task"]["id"] != task_id:
                    raise RuntimeError(
                        "MCP task_get did not preserve the real Node task identity"
                    )
                if len(results["project_context"]["tasks"]) != 2:
                    raise RuntimeError(
                        "MCP project_context did not preserve the isolated project scope"
                    )

                report = {
                    "schema_version": "mcp-full-runtime-local-v1",
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
                        "script_sha256": sha256(
                            Path(__file__).read_bytes()
                        ).hexdigest(),
                        "manifest_sha256": sha256(
                            manifest_path.read_bytes()
                        ).hexdigest(),
                        "corpus_snapshot_sha256": manifest.initial_snapshot.sha256,
                        "node_source_sha256": _source_sha256(
                            [ROOT / "backend-node" / "src"]
                        ),
                        "fastapi_source_sha256": _source_sha256(
                            [
                                ROOT / "backend-ai" / "app",
                                ROOT / "backend-ai" / "main.py",
                            ]
                        ),
                        "mcp_source_sha256": _source_sha256(
                            [MCP_ROOT / "eisenhower_mcp"]
                        ),
                        "node_lock_sha256": sha256(
                            (ROOT / "backend-node" / "package-lock.json").read_bytes()
                        ).hexdigest(),
                        "python_requirements_sha256": sha256(
                            (ROOT / "backend-ai" / "requirements.txt").read_bytes()
                        ).hexdigest(),
                    },
                    "runtime": {
                        "node": "current TypeScript source via tsx",
                        "fastapi": "current Python source via one Uvicorn worker",
                        "mongo": "real local isolated database",
                        "qdrant_version": qdrant_runtime["version"],
                        "qdrant_commit": qdrant_runtime["commit"],
                        "embedding_model": embedding.model_name,
                        "embedding_revision": embedding.revision,
                        "embedding_version": embedding.version,
                        "vector_size": vector_size,
                        "mcp_sdk": "2.0.0",
                        "mcp_transport": "stdio subprocess with SDK handshake",
                        "python": sys.version.split()[0],
                        "node_version": subprocess.check_output(
                            ["node", "--version"], text=True
                        ).strip(),
                        "pymongo": version("pymongo"),
                        "qdrant_client": version("qdrant-client"),
                        "sentence_transformers": version("sentence-transformers"),
                    },
                    "ingestion": ingestion_result,
                    "reconciliation": reconciliation,
                    "mcp": {
                        "tools_called": sorted(results),
                        "tool_count": len(results),
                        "task_count": results["matrix_summary"]["total"],
                        "project_task_count": len(results["project_context"]["tasks"]),
                        "knowledge_hit_count": results["knowledge_search"]["retrieval"][
                            "hit_count"
                        ],
                        "citation_count": len(citations),
                        "citation_source_uris": sorted(
                            {citation["source_uri"] for citation in citations}
                        ),
                        "wrong_project_hit_count": wrong_project["retrieval"][
                            "hit_count"
                        ],
                    },
                    "evidence_boundaries": [
                        "The frozen approved manifest supplies the local demo corpus.",
                        "The two task records are isolated synthetic demo data.",
                        "Retrieval labels and TASK-013 thresholds remain unapproved "
                        "and are not evaluated here.",
                        "No vLLM, generated response, deployment, public HTTPS or "
                        "production traffic is claimed.",
                        "The dirty worktree is identified by relevant artifacts, "
                        "not misrepresented as the base HEAD.",
                    ],
                    "cleanup": cleanup,
                }
    finally:
        _terminate(node_process)
        cleanup["node_stopped"] = (
            node_process is None or node_process.poll() is not None
        )
        _terminate(ai_process)
        cleanup["fastapi_stopped"] = ai_process is None or ai_process.poll() is not None
        cleanup["ports_closed"] = _port_closed(node_port) and _port_closed(ai_port)
        mongo.drop_database(database_name)
        cleanup["mongo_database_dropped"] = (
            database_name not in mongo.list_database_names()
        )
        _delete_alias(qdrant, alias)
        cleanup["qdrant_alias_deleted"] = alias not in {
            item.alias_name for item in qdrant.get_aliases().aliases
        }
        if qdrant.collection_exists(collection_name):
            qdrant.delete_collection(collection_name=collection_name)
        cleanup["qdrant_collection_deleted"] = not qdrant.collection_exists(
            collection_name
        )
        qdrant.close()
        mongo.close()

    if report is None or not all(cleanup.values()):
        raise RuntimeError(
            f"MCP runtime did not finish with verified cleanup: {cleanup}"
        )
    return report


def main() -> None:
    """Write the verified runtime report to the requested JSON artifact."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
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
                "tools": report["mcp"]["tools_called"],
                "knowledge_hit_count": report["mcp"]["knowledge_hit_count"],
                "cleanup": report["cleanup"],
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
