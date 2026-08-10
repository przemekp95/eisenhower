# Haystack comparison spike

This research-only package compares the existing `RagAnalysisService` with a
Haystack adapter over the same `Retriever`, `GenerationProvider`, fallback, and
Pydantic models. It is deliberately absent from production requirements and is
not imported by application code.

The test is an offline orchestration/contract smoke test. Fake I/O makes it
deterministic; it does not claim live Qdrant, SentenceTransformer, vLLM, GPU,
container-size, or production-latency validation.

Run in an isolated virtual environment:

```bash
python3 -m venv /tmp/eisenhower-haystack-spike
/tmp/eisenhower-haystack-spike/bin/pip install -r backend-ai/spikes/haystack_comparison/requirements.txt
PYTHONPATH=backend-ai /tmp/eisenhower-haystack-spike/bin/pytest -c backend-ai/spikes/haystack_comparison/pytest.ini backend-ai/spikes/haystack_comparison/test_comparison.py -q
PYTHONPATH=backend-ai /tmp/eisenhower-haystack-spike/bin/python -m spikes.haystack_comparison.benchmark
```

Do not add this requirements file to `backend-ai/requirements.txt` or the
production Docker build. Native `QdrantDocumentStore` must use a new isolated
collection: its Haystack-owned payload schema is not the flat Eisenhower
payload/ACL schema.
