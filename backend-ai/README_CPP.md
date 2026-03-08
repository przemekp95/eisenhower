# AI Matrix Classifier - Optional C++ Engine

This document covers the optional native classifier described by `main.cpp` and `CMakeLists.txt`. It is not required for the default Python FastAPI service or for the repository CI pipeline, but it can be used as a latency-oriented companion service.

## Scope

The C++ binary is intended to provide:

- a small HTTP surface for health checks and classification
- predictable performance for short classification requests
- a target for the optional hybrid orchestrator documented in `HYBRID_README.md`

If you only need the default API, run the Python service and ignore this file.

## Expected Tooling

Typical Linux dependencies:

```bash
sudo apt update
sudo apt install -y cmake build-essential pkg-config git
```

Additional libraries depend on how far you want to take the native implementation. The current repository does not require the C++ path for tests, so treat external inference dependencies as optional and install them only if you are actively working on the native service.

## Build

### Development build

```bash
cd backend-ai
mkdir -p build
cd build
cmake ..
cmake --build . -j"$(nproc)"
```

### Release build

```bash
cd backend-ai
mkdir -p release
cd release
cmake -DCMAKE_BUILD_TYPE=Release ..
cmake --build . -j"$(nproc)"
```

## Run

```bash
cd backend-ai/build
./AIMatrixClassifier
```

The optional hybrid orchestrator expects the native service to answer on port `8080` unless configured otherwise.

## Expected HTTP Contract

At minimum, keep these endpoints stable:

- `GET /health`
- `POST /classify`

Example request:

```bash
curl -X POST http://localhost:8080/classify \
  -H "Content-Type: application/json" \
  -d '{"task": "Fix the production incident immediately"}'
```

Example response:

```json
{
  "task": "Fix the production incident immediately",
  "urgent": true,
  "important": true,
  "quadrant": 0,
  "quadrant_name": "Do First",
  "method": "C++ classifier"
}
```

## Integration Notes

- Keep the payload shape compatible with the Python service where possible.
- Prefer additive response fields over breaking changes.
- If you extend the native service, update the hybrid orchestrator expectations at the same time.

## Operational Guidance

- Use the C++ engine only when you can justify the extra build and runtime complexity.
- Measure latency and error rate separately from the Python path.
- Preserve a healthy fallback to Python so a native outage does not become an API outage.

## Performance Goals

This repository does not publish guaranteed benchmark numbers for the native path. Treat the C++ engine as a performance experiment until you have measurements from your own workload and hardware.
