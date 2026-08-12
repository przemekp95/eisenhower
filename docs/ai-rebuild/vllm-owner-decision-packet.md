# TASK-015 private vLLM decision packet

Status: **hardware candidate verified locally; model execution remains gated**
Last local inventory: 2026-08-11

TASK-015 remains downstream of the failed/unapproved TASK-013 retrieval gate and the undeployed TASK-014 shadow pilot. This packet records what can already be established without pretending that a model or serving runtime was validated.

## Candidate hardware inventory

| Item | Observed locally | Interpretation |
| --- | --- | --- |
| GPU PCI device | AMD `1002:1586`, subsystem `2014:801d` | Identified by the ROCm 7.0.2 probe as Ryzen AI MAX+ 395 / Radeon 8060S |
| ROCm target | `gfx1151`, 40 compute units | Matches the Ryzen AI MAX family listed by current vLLM GPU requirements |
| Kernel driver | `amdgpu` | Kernel device access exists |
| Exposed VRAM | 17,179,869,184 bytes (16 GiB) | Current firmware/kernel allocation; not yet a measured vLLM capacity limit |
| Host RAM | 109 GiB total | Does not substitute for measured GPU memory or throughput |
| Device nodes | `/dev/kfd`, `/dev/dri/renderD128` | User belongs to `video` and `render`; an isolated ROCm container can be attempted later |
| ROCm userland | Not installed on the host; an ephemeral official ROCm 7.0.2 container successfully ran `rocminfo` and `amd-smi` | GPU visibility is proven without changing host drivers; vLLM/model execution is still unproven |
| Docker runtime | standard `runc`; no NVIDIA runtime | AMD devices would need explicit `/dev/kfd` and `/dev/dri` mapping plus group/security review |
| OS/kernel | Linux `7.0.0-28-generic` | Local candidate only; deployment target is still unselected |

Current vLLM documentation lists Ryzen AI MAX / AI 300 (`gfx1151/1150`) among supported AMD targets and requires ROCm 7.0.2 or newer for that family. A digest-pinned official ROCm 7.0.2 container now proves that the local device is `gfx1151`; this clears hardware-family discovery, not model capacity or vLLM runtime validation. The structured evidence is `backend-ai/evaluation/vllm-hardware-local-v1.json` (SHA-256 `78abcfd56f1cb54d8dd484e4b97c0e63c015227239b67f8be3eac46232a47be7`). See the [current vLLM GPU requirements](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/) and [AMD container device-passthrough guidance](https://rocm.docs.amd.com/projects/install-on-linux/en/latest/how-to/docker.html).

## Provisional model candidate, not a selection

The first post-TASK-014 capacity experiment should use `Qwen/Qwen3-4B-Instruct-2507` pinned to revision `cdbee75f17c01a7cc42f958dc650907174af0554`:

- official model metadata declares Apache-2.0, 4.02B BF16 parameters and a vLLM serving path;
- the model is instruction-tuned and avoids making thinking-mode behavior part of the first structured-output contract;
- the repository declares multilingual capability, but PL quality remains an Eisenhower evaluation question, not a model-card claim;
- the three BF16 shards total about 8.0 GB, which makes 16 GiB a plausible single-request experiment target but does not prove KV-cache or concurrency headroom;
- frozen file hashes are `config.json` `5beea1a4...eeb96`, `tokenizer_config.json` `a62ff0a2...5ce3`, and `LICENSE` `832dd9e0...e92e`.

This is deliberately a provisional, falsifiable candidate. It must not be written into the production PromptSpec or called selected until the earlier retrieval gates pass and a live vLLM run establishes startup, tokenizer/chat-template identity, structured output, PL/EN quality, latency, memory, OOM and fallback behavior. See the [official model card](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507) and [license](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/blob/main/LICENSE).

## Decisions already fixed

- Serving endpoint stays private and OpenAI-compatible behind the existing `GenerationProvider` port.
- One model, tokenizer, chat template and serving stack are selected; no parallel Ollama/LM Studio/SGLang claim.
- Model and tokenizer revisions, chat-template hash, license text and container digest must be immutable artifacts.
- PL and EN PromptSpec variants must bind the same approved model/tokenizer matrix.
- Generated output must pass strict JSON Schema/Pydantic validation and cite only rendered retrieval chunks.
- Missing retrieval, timeout, OOM, malformed output or invalid citation triggers fail-closed fallback/no-answer behavior.
- Generation and response flags remain off through retrieval shadow and generation shadow; enabling a response cohort requires a separate decision.

## Inputs still required before model approval

1. TASK-013: independently reviewed relevance labels and passing retrieval thresholds.
2. TASK-014: authorized target environment, identity/origins, internal cohort, monitoring owner and successful retrieval-only shadow/rollback evidence.
3. Hardware: available GPU memory under vLLM load, power/thermal envelope and whether this host is only a development target or the actual private deployment target. Static `gfx1151`/ROCm visibility is now proven.
4. Model approval: validate the pinned provisional Qwen candidate or record a measured reason to replace it; freeze license obligations, PL/EN results, context limit, structured-output compatibility, memory use and tokenizer/chat template.
5. Capacity target: concurrent requests, input/output token budgets, p50/p95 latency, throughput, timeout, queue depth and acceptable fallback rate.
6. Privacy owner: residency, model-download path, cache/storage retention, prompt/corpus logging policy and incident owner.

## Required execution evidence

- pinned image digest and SBOM/vulnerability review;
- cold and warm startup plus `/health`/model identity verification;
- live contract tests for both languages and strict structured outputs;
- grounded citation/no-answer and prompt-injection/adversarial evaluation;
- concurrency, long-context, OOM, restart and circuit-breaker tests;
- private-network reachability and public-network denial proof;
- generation shadow with sanitized aggregate metrics;
- disable and rollback rehearsal;
- exact report/model/prompt/application SHAs bound in the go/no-go record.

No model name should be written into the production PromptSpec until these inputs are complete. Selecting a small model merely because it fits 16 GiB would be an unverified compatibility decision, not TASK-015 completion.
