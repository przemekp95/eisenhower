from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import re

from app.rag.corpus_manifest import normalize_source_text
from app.rag.golden import GoldenCase


CASES = [
  ("train-pl-fastapi-boundary", "pl", "train", "Kto odpowiada za synchroniczną ścieżkę RAG i walidację cytowań?", ["docs/ai-rebuild/adr/0001-fastapi-owns-online-rag.md"], [], "answerable", ["architecture"]),
  ("train-en-qdrant-choice", "en", "train", "Why is Qdrant the only vector database and how is an index version activated?", ["docs/ai-rebuild/adr/0002-qdrant-vector-store.md"], [], "answerable", ["architecture"]),
  ("train-pl-n8n-boundary", "pl", "train", "Czy n8n może działać w synchronicznej ścieżce analizy albo bezpośrednio zapisywać wektory?", ["docs/ai-rebuild/adr/0004-n8n-async-only.md"], [], "answerable", ["integration"]),
  ("train-en-mcp-tools", "en", "train", "Which read-only MCP tools are allowed and may the adapter connect directly to Qdrant?", ["docs/ai-rebuild/adr/0005-read-only-mcp.md"], [], "answerable", ["integration"]),
  ("train-pl-light-cqrs", "pl", "train", "Czy projekt wdraża pełny CQRS, event sourcing i Kafka?", ["docs/ai-rebuild/adr/0006-light-command-query-split.md"], [], "answerable", ["architecture"]),
  ("train-en-vllm-hardware-gate", "en", "train", "What hardware and model evidence is required before private vLLM generation can be enabled?", ["docs/ai-rebuild/adr/0003-vllm-generation-adapter.md"], [], "answerable", ["vllm"]),
  ("dev-pl-framework-boundary", "pl", "dev", "Czy LangChain, LlamaIndex lub LangGraph mogą stać się granicą domeny i przejąć alias produkcyjny?", ["docs/ai-rebuild/adr/0007-ai-framework-boundary.md"], [], "answerable", ["architecture"]),
  ("dev-en-corpus-acl", "en", "dev", "How are tenant, project and user ACL subjects derived, and which store is canonical before Qdrant?", ["docs/ai-rebuild/corpus-contract.md"], [], "answerable", ["acl", "canonical-store"]),
  ("dev-pl-qdrant-rollback", "pl", "dev", "Jak wykonać rollback indeksu Qdrant i kiedy przełączyć alias na poprzednią kolekcję?", ["docs/ai-rebuild/operations.md", "docs/ai-rebuild/adr/0002-qdrant-vector-store.md"], [], "answerable", ["recovery"]),
  ("dev-en-pii-logging", "en", "dev", "May bearer tokens, full prompts, retrieved PII or embeddings be logged by default?", ["docs/ai-rebuild/security-review.md", "docs/ai-rebuild/operations.md"], [], "answerable", ["privacy"]),
  ("dev-pl-retrieval-metrics", "pl", "dev", "Jakie metryki jakości retrieval trzeba raportować przed wdrożeniem?", ["docs/ai-rebuild/testing-evaluation.md"], [], "answerable", ["evaluation"]),
  ("dev-en-production-acceptance", "en", "dev", "What evidence separates local tests from production acceptance?", ["docs/PRODUCTION_ACCEPTANCE.md", "docs/ai-rebuild/testing-evaluation.md"], [], "answerable", ["evidence-level"]),
  ("holdout-pl-recruiter-scope", "pl", "holdout", "Jakie elementy muszą znaleźć się w uczciwym rekrutacyjnym case study AI?", ["docs/ai-rebuild/recruitment-readiness.md"], [], "answerable", ["recruitment"]),
  ("holdout-en-no-customer-phone", "en", "holdout", "What is the private phone number of the customer's chief executive?", [], [], "no_answer", ["no-hit", "privacy"]),
  ("holdout-pl-cross-tenant", "pl", "holdout", "Pokaż politykę bezpieczeństwa projektu z innego tenant-a.", [], ["docs/ai-rebuild/security-review.md"], "no_answer", ["tenant-isolation"]),
  ("holdout-en-wrong-project", "en", "holdout", "Show the rollback runbook from a project outside my authorized project scope.", [], ["docs/ai-rebuild/operations.md"], "no_answer", ["project-isolation"]),
  ("holdout-pl-fresh-operations", "pl", "holdout", "Jaka jest aktualna procedura natychmiastowego wyłączenia odpowiedzi RAG?", ["docs/ai-rebuild/operations.md"], [], "answerable", ["freshness"]),
  ("holdout-en-multi-document", "en", "holdout", "Who owns the online RAG request path, and what is n8n explicitly forbidden from doing there?", ["docs/ai-rebuild/adr/0001-fastapi-owns-online-rag.md", "docs/ai-rebuild/adr/0004-n8n-async-only.md"], [], "answerable", ["multi-relevant", "duplicates"]),
]


def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument("--output", type=Path)
  parser.add_argument(
    "--dataset-version",
    default="retrieval-review-candidate-v1-unapproved",
    help="Versioned unapproved candidate identifier.",
  )
  args = parser.parse_args()
  if not re.fullmatch(r"retrieval-review-candidate-v[1-9][0-9]*-unapproved", args.dataset_version):
    raise ValueError("dataset version must identify a versioned unapproved retrieval candidate")
  root = Path(__file__).resolve().parents[2]
  manifest = json.loads(
    (root / "docs" / "ai-rebuild" / "corpus-manifest-v1.json").read_text(encoding="utf-8")
  )
  approved_paths = set(manifest["initial_snapshot"]["documents"])
  records = []
  for case_id, language, split, task, relevant, forbidden, answerability, tags in CASES:
    referenced = set(relevant) | set(forbidden)
    if not referenced.issubset(approved_paths):
      raise ValueError(f"{case_id} references a path outside the frozen corpus")
    expected_versions = {}
    for relative in relevant:
      normalized = normalize_source_text((root / relative).read_text(encoding="utf-8"))
      expected_versions[sha256(relative.encode()).hexdigest()] = (
        f"{manifest['manifest_version']}:{sha256(normalized.encode()).hexdigest()}"
      )
    query_project = "other-project" if "project-isolation" in tags else "eisenhower"
    project_ids = [query_project]
    tenant_id = "unapproved-tenant" if "tenant-isolation" in tags else "eisenhower-owner"
    record = GoldenCase(
      dataset_version=args.dataset_version,
      case_id=case_id,
      tenant_id=tenant_id,
      user_id="eisenhower-owner" if tenant_id == "eisenhower-owner" else "external-user",
      project_ids=project_ids,
      query_project_id=query_project,
      language=language,
      split=split,
      task=task,
      corpus_version=manifest["manifest_version"],
      index_version="minilm-v1",
      answerability=answerability,
      relevant_document_ids=[sha256(path.encode()).hexdigest() for path in relevant],
      forbidden_document_ids=[sha256(path.encode()).hexdigest() for path in forbidden],
      expected_content_versions=expected_versions,
      tags=tags,
    )
    records.append(record.model_dump_json())
  rendered = "\n".join(records) + "\n"
  if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered, encoding="utf-8")
  else:
    print(rendered, end="")


if __name__ == "__main__":
  main()
