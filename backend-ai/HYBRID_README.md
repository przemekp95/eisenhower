# AI Matrix Classifier - Hybrid Python + C++ Notes

This repository currently runs a Python FastAPI service by default. The hybrid path described here is an optional design in which a Python orchestrator delegates low-latency requests to a separate C++ inference process.

## Purpose

Use the hybrid model when you need both:

- a stable Python API surface for orchestration, training-data management, and complex analysis
- an optional low-latency C++ engine for selected classification requests

The Python service remains the source of truth for API compatibility. The C++ service is treated as an accelerator, not a hard dependency.

## Responsibility Split

```text
Python orchestrator
- HTTP API surface
- fallback classification path
- training data management
- richer analysis endpoints
- metrics and operational control

C++ engine
- latency-sensitive classification
- fixed contract for health and inference
- optional acceleration path
```

## Routing Strategy

The existing `fusion_server.py` follows a simple decision tree:

- short, plain-text requests can be routed to C++
- complex or longer inputs stay on Python
- if the C++ engine is unavailable, Python handles the request

That gives a safe degradation path: the API can keep serving requests even if the accelerator is offline.

## Current Repository State

- `main.py` starts the import-safe FastAPI app from `app.create_app()`
- `fusion_server.py` contains the experimental hybrid orchestrator
- `README_CPP.md` documents the optional C++ engine build
- CI validates the Python service; the hybrid path is not required for the default test pipeline

## Running the Python Service

```bash
cd backend-ai
python3 -m pip install -r requirements.txt
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## Running the Hybrid Stack

The hybrid mode requires a compiled `AIMatrixClassifier` binary in `backend-ai/`.

```bash
cd backend-ai

# Build the optional C++ engine first. See README_CPP.md.
mkdir -p build
cd build
cmake ..
cmake --build . -j"$(nproc)"
cd ..

# Start the Python orchestrator that can delegate to C++
python3 fusion_server.py
```

## Expected C++ Contract

The orchestrator expects the C++ service to expose at least:

- `GET /health`
- `POST /classify`

Example classification payload:

```json
{
  "task": "Fix the production incident immediately"
}
```

Example response:

```json
{
  "task": "Fix the production incident immediately",
  "urgent": true,
  "important": true,
  "quadrant": 0,
  "quadrant_name": "Do First",
  "engine": "C++ Inference Engine"
}
```

## Operational Notes

- Keep the Python path healthy even if the C++ process is down.
- Treat latency metrics for Python and C++ separately.
- If you evolve the routing logic, preserve the fallback behavior first and optimize second.

## When Hybrid Is Worth It

- public endpoints with a large volume of short classification requests
- mobile or edge-adjacent traffic where latency matters
- mixed workloads where only part of the traffic benefits from a native accelerator

If the extra operational complexity is not justified, keep the default FastAPI-only deployment.
