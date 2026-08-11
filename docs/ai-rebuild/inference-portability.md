# Portable private inference boundary

FastAPI owns browser/service authentication, tenant and project ACLs, retrieval, prompt rendering,
structured-output validation, citation enforcement, bounded metrics and the classifier fallback.
`GenerationProvider` owns no vendor or location decision. Its infrastructure adapter calls one fixed,
private OpenAI-compatible endpoint synchronously; ingestion, reindex and evaluation remain the only
asynchronous worker use cases.

```text
Web / Mobile -> FastAPI -> GenerationProvider -> private OpenAI-compatible endpoint
                              | timeout/error/invalid output
                              +-> local MiniLM classifier fallback
```

`RAG_RETRIEVAL_ENABLED`, `RAG_GENERATION_ENABLED` and `RAG_RESPONSE_ENABLED` remain independent.
Generation cannot start without retrieval, while FastAPI liveness/readiness does not depend on the
optional inference node. `/health/ready` reports its bounded circuit state as an optional dependency;
`/metrics` exposes bounded fallback reasons and circuit state without host, tenant, prompt or corpus labels.

## Deployment combinations

| Application location | Inference location | Configuration |
| --- | --- | --- |
| user computer | same computer | one opt-in NVIDIA or AMD Compose profile; private Compose network |
| dedicated host | user computer | FastAPI uses the computer's VPN/mesh address; no application data store moves there |
| user computer | dedicated host | FastAPI uses the host's private VPC/VPN address |
| dedicated host | dedicated GPU host | private VPC/VPN routing and an allowlisted service identity |

An entry in `INFERENCE_ALLOWED_HOSTS` authorizes only the configured DNS name; it does not prove that
DNS, routing, firewall or TLS is private. A remote deployment must independently prove VPN/VPC or mTLS,
deny public ingress, rotate a dedicated service credential, and avoid forwarding end-user credentials.
No profile contains `ports`; `expose` is container-network metadata only. Request-body logging is disabled.

## Hardware/runtime/model matrix

Every row stays unselected until its own physical gate passes. A Compose render or mocked HTTP contract
does not change status to live-passed.

| Vendor/runtime | Location | Exact accelerator/VRAM | Driver/runtime | Candidate image | Model/tokenizer/quantization | Status |
| --- | --- | --- | --- | --- | --- | --- |
| NVIDIA/CUDA | local | unselected | unselected | `vllm/vllm-openai:v0.20.0`; digest pending | unselected | contract-only |
| NVIDIA/CUDA | dedicated host | unselected | unselected | same contract; digest pending | unselected | contract-only |
| AMD/ROCm | local | Ryzen AI MAX+ 395 / Radeon 8060S, `gfx1151`, 16 GiB exposed by the prior ROCm probe | `amdgpu`; ROCm 7.0.2 probe only, no host userland or vLLM run | `vllm/vllm-openai-rocm:v0.20.0`; digest pending | provisional Qwen candidate only; dtype/quantization unselected | hardware candidate; inference unverified |
| AMD/ROCm | dedicated host | unselected | unselected | same contract; digest pending | unselected | contract-only |

The local AMD inventory is evidence-bound in
`backend-ai/evaluation/vllm-hardware-local-v1.json`; it proves only device visibility and a documented
hardware-family match. It does not prove model loading, structured output, usable VRAM, throughput,
concurrency, thermals or OOM behavior. Current vLLM documentation provides official, separate NVIDIA
and ROCm images; exact device/version support must be refreshed at TASK-015 execution time.

## Live gates for one concrete host

1. Freeze accelerator model/architecture, exposed VRAM, OS/kernel, driver, CUDA or ROCm, vLLM image
   digest/SBOM, model and license revision, tokenizer revision/chat-template hash, dtype/quantization,
   context and concurrency.
2. Prove public-network denial, private DNS/routing, service-auth rejection/rotation and TLS or the
   explicitly approved VPN/VPC trust boundary. Do not log prompts, retrieved text or response bodies.
3. With auth, verify `/health`, exact model identity from `/v1/models`, metrics reachability and a loaded
   model. Process health alone is insufficient.
4. Run the opt-in live contract in PL and EN, strict JSON Schema, citations/no-answer, prompt injection,
   timeout, 429/5xx, interrupted connection, restart and fallback checks.
5. Measure cold/warm startup, p50/p95/p99, tokens/s, queueing, concurrent requests, context limits,
   VRAM/KV cache, OOM recovery, thermals and power on that exact matrix.
6. Prove that FastAPI remains ready and returns classifier fallback when the node is absent, sleeping,
   overloaded or disconnected; rehearse disable and model rollback.
7. Bind results to application, prompt, model and image hashes. Only then may TASK-015 mark the row
   live-passed; TASK-023 separately governs shadow and response canary.

Official references: [vLLM Docker images](https://docs.vllm.ai/en/stable/deployment/docker/),
[vLLM hardware installation matrix](https://docs.vllm.ai/en/stable/getting_started/installation/index.html),
and [PyTorch ROCm semantics](https://docs.pytorch.org/docs/stable/notes/hip.html).
