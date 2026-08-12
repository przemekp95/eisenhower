# TASK-013 retrieval review packet

Status: **unapproved candidate — independent human review required**

## Current refrozen packet (v2)

## Current technical candidate (v3)

The v3 packet adds only balanced train/dev coverage and preserves the six v2 holdout records
semantically unchanged. `human-review-v3.json` is bound to the current candidate, thresholds and
corpus manifest; all 42 decisions remain `PENDING`. The holdout has not been run.

Train-only selection on the local AMD host chose fielded BM25/RRF plus revision-pinned
`BAAI/bge-reranker-v2-m3` through a loopback-only ROCm/vLLM scoring service. The 192-token,
20-candidate result passes the proposed non-holdout quality, latency and zero-tolerance gates, but
does not substitute for independent relevance review. Dense remains the runtime default until the
human record is complete and the untouched holdout passes.

Authoritative technical report: `dense-hybrid-reranker-gpu192-v3-20260812.json`.

The authoritative current inputs after the unchanged 19-file allowlist was refrozen on 2026-08-12 are:

- candidate: `review-candidate-v2.jsonl`, SHA-256 `9bd58f71daadcaf46faaf05a2c4d2bec43d56d1865d69f4ce914b830cb589506`;
- corpus manifest SHA-256: `0528fe77fd68e46afba65e1febc8f1a8372d6f98e9dcdb83caaff54cc51fbbef`;
- corpus snapshot SHA-256: `e851ef8725cf22ee858f706b1f7b1becbec051ba30f85a6dc531c5b24a407f37`;
- review record to complete: `human-review-v2.json` (18 decisions remain `PENDING`);
- write-once technical comparison: `dense-hybrid-comparison-v2-20260812.json`, SHA-256 `383df23055202c49ba033201b6029ed6e2dff18ee009061d098c5b33cbe89b0c`.

The v1 material below is retained as historical evidence and must not be completed against the
refrozen corpus. The v2 comparison is non-holdout and does not substitute for independent human
relevance review.

## Frozen inputs

- Candidate labels: `review-candidate-v1.jsonl`
- Candidate SHA-256: `5966f79ee4f9e04f9485073c3efc7c86195aeedd615ae7aeb8bf89132f1b1ba0`
- Candidate count: 18 cases
- Distribution: 6 train, 6 dev, 6 holdout; 9 PL and 9 EN
- Threshold proposal: `review-candidate-v1-thresholds.json`
- Threshold proposal SHA-256: `e37602d4cbd9a304675382b7d32d999a977631405fc8527bfb29388779e521bb`
- Corpus: `eisenhower-corpus-v1`, approved initial snapshot only
- Corpus manifest SHA-256: `b022333de73442927099881fdb4e327d7edea0feb1eba9ad809511e9ccec9f5f`
- Corpus snapshot SHA-256: `7d52fdd5f973f62a19f3c67a1afcfbe3d4990d80c75439e550b34f5d6188dd43`
- Dataset marker: `retrieval-review-candidate-v1-unapproved`
- Local runtime report SHA-256: `16ff06d03483b803d373bd35d2743649485436908ba9c9420114a95d7cb9d0b8`
- Provisional assessment SHA-256: `f7f63566a6370edc6eca1faf2e26090f783a1c7e2a865767e44fb6cedbc8da3d`
- Human-readable review guide: `HUMAN_REVIEW_WORKSHEET.md`
- Authoritative machine review record: `human-review-v1.json`
- Review-template SHA-256: `64681ab1c55242683d45a035f7b731c95e92de17e7bcfbea86f1a0b0bc6bbfc3`

## Untuned local diagnostic

The refreshed isolated local run remains a provisional **fail** against the
unchanged proposed thresholds. It is not human approval and was not used to
change labels, thresholds or the frozen holdout.

| Slice | Recall@5 | MRR@5 | No-answer accuracy |
| --- | ---: | ---: | ---: |
| Global | `0.6667` | `0.5444` | `0.9444` |
| Polish | `0.4375` | `0.4375` | `1.0000` |
| English | `0.9286` | `0.6667` | `0.8889` |
| Holdout | `0.6667` | `0.5000` | `0.8333` |

Duplicate-hit, stale-hit, forbidden-hit and isolation-violation rates were all
`0.0000`; freshness was `1.0000`; local warm p95 was `14.7025 ms`. The runtime
report records successful cleanup of its isolated MongoDB database and Qdrant
collection.

## What the reviewer must decide

Review every JSONL record against the cited frozen source documents, without using retrieval output as the authority. For each case, approve or edit the permitted relevance fields:

1. query wording, language and train/dev/holdout split; if any is wrong, reject this packet and issue a newly versioned candidate rather than mutating the observed holdout;
2. `answerability`;
3. complete `relevant_document_ids` (not merely one plausible hit);
4. `forbidden_document_ids`, `stale_document_ids` and expected content versions;
5. the global and sliced thresholds in the threshold proposal.

The reviewer must explicitly confirm that no case exposes or requests real private data. Cross-tenant and cross-project cases are negative isolation probes and must remain no-answer.

## Required approval record

Complete `human-review-v1.json`; it is already bound to all four frozen input
hashes and contains one fail-closed decision slot per candidate case. It must contain:

- reviewer name or stable reviewer ID;
- review timestamp in UTC;
- exact candidate and threshold file SHA-256 values;
- per-case outcome (`approved` or an explicit corrected replacement record);
- final threshold values;
- an explicit statement that relevance judgments were made independently by a human.

Do not rename the candidate version to an approved version and do not run tuning against holdout until that record exists. AI generation, local tests, or owner authorization cannot substitute for independent relevance review.

After the human has checked the frozen sources directly, finalize with:

```bash
backend-ai/venv/bin/python backend-ai/scripts/finalize_retrieval_review.py \
  --candidate backend-ai/evaluation/retrieval-v1/review-candidate-v1.jsonl \
  --thresholds backend-ai/evaluation/retrieval-v1/review-candidate-v1-thresholds.json \
  --corpus-manifest docs/ai-rebuild/corpus-manifest-v1.json \
  --review backend-ai/evaluation/retrieval-v1/human-review-v1.json \
  --output-dataset backend-ai/evaluation/retrieval-v1/retrieval-golden-v1-human-attested.jsonl \
  --output-manifest backend-ai/evaluation/retrieval-v1/retrieval-golden-v1-attestation.json
```

The finalizer rejects `PENDING` fields, input or physical corpus drift, duplicate
or missing decisions, weakened zero-tolerance controls, altered security probes,
and conflicting pre-existing output paths. It records a human attestation, not
cryptographic proof that a human performed the review; TASK-013 therefore still
requires out-of-band confirmation of reviewer provenance. After that confirmation,
a fresh untuned retrieval run must pass before TASK-014 can begin.

## Proposed acceptance interpretation

- Zero tolerance: forbidden, isolation or stale hits.
- Quality: Recall@5 and MRR@5 must pass globally and for PL, EN and holdout slices.
- No-answer: every negative isolation/privacy case must return no hit.
- Duplicates: repeated chunk IDs count as failures even if the source document is relevant.
- Latency: local warm p95 is an engineering observation only, not deployment evidence.
