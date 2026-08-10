from __future__ import annotations

import json
import sys
from pathlib import Path
from statistics import median, quantiles
from time import perf_counter
from types import ModuleType


app = ModuleType("app")
app.__path__ = [str(Path(__file__).parents[2] / "app")]
sys.modules.setdefault("app", app)

from app.rag.application import RagAnalysisService
from app.rag.models import AccessScope, GenerationResult, RetrievalHit

from .comparison import HaystackAnalysisAdapter


class _Retriever:
  def __init__(self, hit):
    self.hit = hit

  def retrieve(self, query):
    return [self.hit]


class _Generator:
  def generate(self, request):
    return GenerationResult(
      quadrant=2,
      confidence=0.91,
      explanation="Grounded in project context.",
      cited_chunk_ids=[request.context[0].chunk_id],
    )


class _Fallback:
  def classify_task(self, task, use_rag=False):
    return {"quadrant": 1, "quadrant_name": "Delegate", "confidence": 0.6}


def _dependencies():
  hit = RetrievalHit(
    chunk_id="chunk-1",
    document_id="document-1",
    text="Roadmap work is important but not urgent.",
    score=0.92,
    source_uri="eisenhower://project/alpha/context",
    title="Project alpha",
    tenant_id="tenant-a",
    project_id="alpha",
    owner_id="user-a",
    embedding_version="minilm-v1",
    content_version="v1",
    source_type="project_context",
  )
  return _Retriever(hit), _Generator(), _Fallback()


def _measure(service, scope, iterations):
  samples = []
  for _ in range(iterations):
    started = perf_counter()
    service.analyze("Prepare roadmap", scope)
    samples.append((perf_counter() - started) * 1000)
  return {
    "p50_ms": round(median(samples), 4),
    "p95_ms": round(quantiles(samples, n=100)[94], 4),
    "iterations": iterations,
  }


def main(iterations: int = 1000):
  scope = AccessScope(
    tenant_id="tenant-a",
    user_id="user-a",
    project_ids=["alpha"],
    roles=["member"],
  )
  direct_started = perf_counter()
  direct = RagAnalysisService(*_dependencies())
  direct_build_ms = (perf_counter() - direct_started) * 1000
  haystack_started = perf_counter()
  candidate = HaystackAnalysisAdapter(*_dependencies())
  haystack_build_ms = (perf_counter() - haystack_started) * 1000

  direct.analyze("Prepare roadmap", scope)
  candidate.analyze("Prepare roadmap", scope)
  result = {
    "scope": "in-process orchestration only; fake I/O; warmed once",
    "direct_build_ms": round(direct_build_ms, 4),
    "haystack_build_ms": round(haystack_build_ms, 4),
    "direct": _measure(direct, scope, iterations),
    "haystack": _measure(candidate, scope, iterations),
  }
  print(json.dumps(result, indent=2))


if __name__ == "__main__":
  main()
