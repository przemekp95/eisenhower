# ADR 0003: private vLLM generation adapter with a hardware gate

Status: accepted conditionally; no model is selected.

## Decision

Use vLLM through its OpenAI-compatible HTTP API behind `GenerationProvider`. The first role is grounded generation; the existing MiniLM model remains the embedding provider. Add a reranker only if evaluation shows retrieval quality cannot meet the agreed threshold.

The endpoint is fixed configuration, private-network only, authenticated, non-redirecting and subject to strict connect/read/overall timeouts. FastAPI validates vLLM JSON against its own Pydantic schema and rejects citations not present in retrieved context.

## Hardware gate

Before choosing a model, record target accelerator vendor, driver/runtime, per-device VRAM, number of devices, supported dtype/quantization, expected context, concurrency and latency SLO. Then measure model weights, KV cache and concurrency headroom with the actual vLLM engine arguments. The current local machine/runtime does not establish suitable GPU/VRAM.

## Resilience and operations

- Circuit opens after a measured threshold of failures; half-open probes are bounded.
- A total generation timeout falls back without retry storms. Retry only safe transient failures and at most once in the request path.
- `/health` is readiness evidence only when it also proves the configured model is loaded; scrape vLLM metrics and alert on queueing, cache pressure, OOM and error rates.
- Never log bearer tokens, complete prompts, retrieved PII or generated raw bodies by default.
- Contract tests use a fake OpenAI-compatible server; staging adds the selected live model.

References: [OpenAI-compatible server](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/), [structured output](https://docs.vllm.ai/en/stable/features/structured_outputs/), [metrics](https://docs.vllm.ai/en/latest/usage/metrics/), [engine arguments](https://docs.vllm.ai/en/stable/configuration/engine_args/).

## Gate

No-go while hardware/VRAM, model license, data residency, throughput, latency, OOM behavior and structured-output compatibility are unknown.
