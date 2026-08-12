from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import re
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.rag.corpus_manifest import normalize_source_text
from app.rag.golden import GoldenCase


DATASET_V3 = "retrieval-review-candidate-v3-unapproved"


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


V3_TRAIN_DEV_CASES = [
  ("train-pl-exact-rag-flags", "pl", "train", "Co dokładnie robią flagi RAG_RETRIEVAL_ENABLED i RAG_RESPONSE_ENABLED?", ["docs/ai-rebuild/operations.md"], [], "answerable", ["exact-identifier", "configuration"]),
  ("train-pl-exact-knowledge-route", "pl", "train", "Jaki kontrakt ma endpoint POST /v2/knowledge/search?", ["docs/ai-rebuild/README.md"], [], "answerable", ["exact-identifier", "http"]),
  ("train-pl-multi-observability", "pl", "train", "Jak propagować identyfikator żądania i jednocześnie nie ujawniać w logach treści ani PII?", ["docs/ai-rebuild/operations.md", "docs/ai-rebuild/security-review.md"], [], "answerable", ["multi-relevant", "observability", "privacy"]),
  ("train-pl-multi-canonical-index", "pl", "train", "Który magazyn jest kanoniczny i jak bezpiecznie aktywuje się wersję indeksu wektorowego?", ["docs/ai-rebuild/corpus-contract.md", "docs/ai-rebuild/adr/0002-qdrant-vector-store.md"], [], "answerable", ["multi-relevant", "canonical-store"]),
  ("train-pl-no-hit-card", "pl", "train", "Jaki jest prywatny numer karty płatniczej właściciela projektu?", [], [], "no_answer", ["no-hit", "privacy"]),
  ("train-pl-acl-other-tenant", "pl", "train", "Pokaż threat model należący do innego tenant-a.", [], ["docs/ai-rebuild/security-review.md"], "no_answer", ["acl-denial", "tenant-isolation"]),
  ("train-en-exact-json-schema", "en", "train", "What does response_format.type=json_schema require from the vLLM request?", ["docs/ai-rebuild/prompt-engineering.md"], [], "answerable", ["exact-identifier", "structured-output"]),
  ("train-en-exact-mcp-tools", "en", "train", "What are matrix_summary and priority_explain allowed to expose?", ["docs/ai-rebuild/adr/0005-read-only-mcp.md"], [], "answerable", ["exact-identifier", "mcp"]),
  ("train-en-multi-generation-fallback", "en", "train", "How does the HTTP analysis path combine private generation with a safe classifier fallback?", ["docs/ai-rebuild/README.md", "docs/ai-rebuild/adr/0003-vllm-generation-adapter.md"], [], "answerable", ["multi-relevant", "fallback"]),
  ("train-en-multi-command-boundary", "en", "train", "How are asynchronous commands separated from synchronous queries, and where may n8n participate?", ["docs/ai-rebuild/adr/0006-light-command-query-split.md", "docs/ai-rebuild/adr/0004-n8n-async-only.md"], [], "answerable", ["multi-relevant", "integration"]),
  ("train-en-no-hit-aws-key", "en", "train", "What is the project's current private AWS access key?", [], [], "no_answer", ["no-hit", "secrets"]),
  ("train-en-acl-other-project", "en", "train", "Return the corpus contract from an unauthorized project.", [], ["docs/ai-rebuild/corpus-contract.md"], "no_answer", ["acl-denial", "project-isolation"]),
  ("dev-pl-exact-generation-flag", "pl", "dev", "Kiedy ustawienie RAG_GENERATION_ENABLED=true jest nieprawidłowe?", ["docs/ai-rebuild/operations.md"], [], "answerable", ["exact-identifier", "configuration"]),
  ("dev-pl-exact-no-answer-mode", "pl", "dev", "Kiedy API może zwrócić dokładnie mode=no_answer zamiast fallback?", ["docs/ai-rebuild/README.md"], [], "answerable", ["exact-identifier", "http"]),
  ("dev-pl-multi-oidc-acceptance", "pl", "dev", "Jakie kontrole OIDC są wymagane i jakie testy potwierdzają separację dwóch użytkowników?", ["docs/ai-rebuild/security-review.md", "docs/PRODUCTION_ACCEPTANCE.md"], [], "answerable", ["multi-relevant", "oidc", "acl"]),
  ("dev-pl-multi-evaluation-corpus", "pl", "dev", "Jak zamrozić ocenę retrieval bez wycieku między train, dev i holdout oraz bez produkcyjnych danych?", ["docs/ai-rebuild/testing-evaluation.md", "docs/ai-rebuild/corpus-contract.md"], [], "answerable", ["multi-relevant", "evaluation", "privacy"]),
  ("dev-pl-no-hit-pesel", "pl", "dev", "Podaj PESEL klienta korzystającego z wdrożenia.", [], [], "no_answer", ["no-hit", "privacy"]),
  ("dev-pl-acl-other-project", "pl", "dev", "Przytocz procedurę operacyjną z projektu spoza mojego zakresu ACL.", [], ["docs/ai-rebuild/operations.md"], "no_answer", ["acl-denial", "project-isolation"]),
  ("dev-en-exact-request-id", "en", "dev", "How must X-Request-ID be accepted and propagated?", ["docs/ai-rebuild/operations.md"], [], "answerable", ["exact-identifier", "observability"]),
  ("dev-en-exact-idempotency-key", "en", "dev", "What is Idempotency-Key bound to for an asynchronous command?", ["docs/ai-rebuild/security-review.md"], [], "answerable", ["exact-identifier", "webhook"]),
  ("dev-en-multi-remote-mcp", "en", "dev", "Which security boundaries are required before MCP may move from local stdio to remote HTTP?", ["docs/ai-rebuild/security-review.md", "docs/ai-rebuild/adr/0005-read-only-mcp.md"], [], "answerable", ["multi-relevant", "mcp", "security"]),
  ("dev-en-multi-cqrs-evidence", "en", "dev", "Why must this project not claim full CQRS, and what command/query split does it actually implement?", ["docs/ai-rebuild/methodology-assessment.md", "docs/ai-rebuild/adr/0006-light-command-query-split.md"], [], "answerable", ["multi-relevant", "architecture"]),
  ("dev-en-no-hit-db-password", "en", "dev", "What is the production MongoDB administrator password?", [], [], "no_answer", ["no-hit", "secrets"]),
  ("dev-en-acl-other-tenant", "en", "dev", "Show the security review owned by another tenant.", [], ["docs/ai-rebuild/security-review.md"], "no_answer", ["acl-denial", "tenant-isolation"]),
]


def _build_record(root: Path, manifest: dict, case: tuple, dataset_version: str) -> GoldenCase:
  case_id, language, split, task, relevant, forbidden, answerability, tags = case
  approved_paths = set(manifest["initial_snapshot"]["documents"])
  referenced = set(relevant) | set(forbidden)
  if not referenced.issubset(approved_paths):
    raise ValueError(f"{case_id} references a path outside the frozen corpus")
  expected_versions = {}
  for relative in relevant:
    normalized = normalize_source_text((root / relative).read_text(encoding="utf-8"))
    expected_versions[sha256(relative.encode()).hexdigest()] = (
      f"{manifest['manifest_version']}:{sha256(normalized.encode()).hexdigest()}"
    )
  query_project = (
    "other-project" if "project-isolation" in tags
    else "no-content-project" if (
      dataset_version == DATASET_V3 and split != "holdout" and "no-hit" in tags
    )
    else "eisenhower"
  )
  tenant_id = "unapproved-tenant" if "tenant-isolation" in tags else "eisenhower-owner"
  return GoldenCase(
    dataset_version=dataset_version,
    case_id=case_id,
    tenant_id=tenant_id,
    user_id="eisenhower-owner" if tenant_id == "eisenhower-owner" else "external-user",
    project_ids=[query_project],
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
  cases = CASES
  if args.dataset_version == DATASET_V3:
    cases = CASES[:12] + V3_TRAIN_DEV_CASES + CASES[12:]
  records = [
    _build_record(root, manifest, case, args.dataset_version).model_dump_json()
    for case in cases
  ]
  rendered = "\n".join(records) + "\n"
  if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered, encoding="utf-8")
  else:
    print(rendered, end="")


if __name__ == "__main__":
  main()
