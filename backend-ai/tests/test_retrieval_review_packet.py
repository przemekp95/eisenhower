from __future__ import annotations

from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys

from app.rag.golden import load_golden_dataset
from app.rag.human_review import build_review_template


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
EVALUATION_ROOT = REPOSITORY_ROOT / "backend-ai/evaluation/retrieval-v1"
V3_VERSION = "retrieval-review-candidate-v3-unapproved"


def _generate_candidate(output: Path, version: str) -> None:
  subprocess.run(
    [
      sys.executable,
      str(REPOSITORY_ROOT / "backend-ai/scripts/generate_retrieval_review_packet.py"),
      "--dataset-version",
      version,
      "--output",
      str(output),
    ],
    cwd=REPOSITORY_ROOT,
    check=True,
  )


def _without_version(line: str) -> bytes:
  record = json.loads(line)
  del record["dataset_version"]
  return json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def test_v2_holdout_remains_reproducible(tmp_path):
  generated = tmp_path / "candidate-v2.jsonl"
  _generate_candidate(generated, "retrieval-review-candidate-v2-unapproved")

  generated_holdout = [
    line for line in generated.read_text(encoding="utf-8").splitlines()
    if json.loads(line)["split"] == "holdout"
  ]
  frozen_holdout = [
    line
    for line in (EVALUATION_ROOT / "review-candidate-v2.jsonl").read_text(encoding="utf-8").splitlines()
    if json.loads(line)["split"] == "holdout"
  ]
  assert generated_holdout == frozen_holdout


def test_v3_expands_only_train_and_dev_and_preserves_holdout_semantics(tmp_path):
  generated = tmp_path / "candidate-v3.jsonl"
  _generate_candidate(generated, V3_VERSION)
  v3 = load_golden_dataset(generated)
  v2_lines = (EVALUATION_ROOT / "review-candidate-v2.jsonl").read_text(encoding="utf-8").splitlines()
  v3_lines = generated.read_text(encoding="utf-8").splitlines()
  v2_holdout = [line for line in v2_lines if json.loads(line)["split"] == "holdout"]
  v3_holdout = [line for line in v3_lines if json.loads(line)["split"] == "holdout"]

  assert len(v3) == 42
  assert Counter(case.split for case in v3) == {"train": 18, "dev": 18, "holdout": 6}
  assert Counter(case.language for case in v3) == {"pl": 21, "en": 21}
  assert [json.loads(line)["case_id"] for line in v3_holdout] == [
    json.loads(line)["case_id"] for line in v2_holdout
  ]
  assert [_without_version(line) for line in v3_holdout] == [
    _without_version(line) for line in v2_holdout
  ]

  existing_ids = {json.loads(line)["case_id"] for line in v2_lines}
  additions = [case for case in v3 if case.case_id not in existing_ids]
  assert len(additions) == 24
  assert {case.split for case in additions} == {"train", "dev"}
  assert Counter((case.split, case.language) for case in additions) == {
    ("train", "pl"): 6,
    ("train", "en"): 6,
    ("dev", "pl"): 6,
    ("dev", "en"): 6,
  }
  for split in ("train", "dev"):
    for language in ("pl", "en"):
      slice_cases = [
        case for case in additions if case.split == split and case.language == language
      ]
      assert sum("exact-identifier" in case.tags for case in slice_cases) == 2
      assert sum("multi-relevant" in case.tags for case in slice_cases) == 2
      assert sum("no-hit" in case.tags for case in slice_cases) == 1
      assert sum("acl-denial" in case.tags for case in slice_cases) == 1
      assert all(len(case.relevant_document_ids) == 2 for case in slice_cases if "multi-relevant" in case.tags)
      assert all(case.answerability == "no_answer" for case in slice_cases if {"no-hit", "acl-denial"} & set(case.tags))


def test_v3_human_review_template_is_hash_bound_and_fully_pending(tmp_path):
  candidate = tmp_path / "candidate-v3.jsonl"
  _generate_candidate(candidate, V3_VERSION)
  review = build_review_template(
    candidate,
    EVALUATION_ROOT / "review-candidate-v1-thresholds.json",
    REPOSITORY_ROOT / "docs/ai-rebuild/corpus-manifest-v1.json",
  )

  assert review["candidate_sha256"] == sha256(candidate.read_bytes()).hexdigest()
  assert len(review["decisions"]) == 42
  assert {decision["outcome"] for decision in review["decisions"]} == {"PENDING"}
  assert review["reviewer_id"] == "PENDING"
  assert review["labels_decision"] == "PENDING"
  assert review["thresholds_decision"] == "PENDING"
  assert review["reviewer_attestation"] == "PENDING"
  assert candidate.read_bytes() == (EVALUATION_ROOT / "review-candidate-v3.jsonl").read_bytes()
  assert review == json.loads((EVALUATION_ROOT / "human-review-v3.json").read_bytes())
