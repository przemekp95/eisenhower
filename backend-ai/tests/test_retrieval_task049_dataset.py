from collections import Counter
import json

import pytest

from app.rag.task049_evaluation import (
  assert_no_query_overlap,
  generate_dataset,
  generate_task050_development_dataset,
  seed_commitment,
)


def test_task049_dataset_is_deterministic_balanced_and_synthetic():
  seed = bytes.fromhex("11" * 32)

  first = generate_dataset(seed, split="calibration")
  second = generate_dataset(seed, split="calibration")

  assert first == second
  assert len(first.cases) == 96
  assert Counter(case.language for case in first.cases) == {"pl": 48, "en": 48}
  assert Counter(case.split for case in first.cases) == {"train": 96}
  assert Counter(tag for case in first.cases for tag in case.tags if tag.startswith("category:")) == {
    "category:exact-id": 16,
    "category:paraphrase": 16,
    "category:lexical-confusable": 16,
    "category:multi-document": 16,
    "category:no-answer-domain": 8,
    "category:no-answer-project": 8,
    "category:no-answer-tenant": 8,
    "category:no-answer-stale": 8,
  }
  assert all(document.source_uri.startswith("https://docs.invalid/") for document in first.documents)
  assert all("eisenhower" not in case.task.casefold() for case in first.cases)
  paraphrases = [case for case in first.cases if "category:paraphrase" in case.tags]
  assert all("orion-" not in case.task.casefold() for case in paraphrases)
  assert {case.dataset_version for case in first.cases} == {"task049-synthetic-calibration-v2"}


def test_task049_validation_seed_changes_every_identity_and_maps_to_dev():
  calibration = generate_dataset(bytes.fromhex("22" * 32), split="calibration")
  validation = generate_dataset(bytes.fromhex("33" * 32), split="validation")

  assert {case.case_id for case in calibration.cases}.isdisjoint(
    case.case_id for case in validation.cases
  )
  assert {document.document_id for document in calibration.documents}.isdisjoint(
    document.document_id for document in validation.documents
  )
  assert Counter(case.split for case in validation.cases) == {"dev": 96}


def test_task050_development_adds_balanced_unstructured_no_answer_hard_negatives():
  dataset = generate_task050_development_dataset(bytes.fromhex("44" * 32))

  assert len(dataset.cases) == 104
  assert Counter(case.language for case in dataset.cases) == {"pl": 52, "en": 52}
  assert Counter(case.answerability for case in dataset.cases) == {
    "answerable": 64,
    "no_answer": 40,
  }
  hard_negatives = [
    case for case in dataset.cases
    if "category:no-answer-unstructured" in case.tags
  ]
  assert len(hard_negatives) == 8
  assert all(case.split == "dev" for case in dataset.cases)
  assert all(case.dataset_version == "task050-development-v1" for case in dataset.cases)
  assert all(not case.relevant_document_ids for case in hard_negatives)


def test_task049_seed_commitment_and_query_overlap_guard(tmp_path):
  seed = bytes.fromhex("44" * 32)
  dataset = generate_dataset(seed, split="calibration")
  prior = tmp_path / "prior.jsonl"
  prior.write_text(json.dumps({"task": dataset.cases[0].task}) + "\n", encoding="utf-8")

  assert seed_commitment(seed) == "bb391415c05e39d77ca17381d3be3f7d0cd5e5332e5a579311adaa0aa62106e9"
  with pytest.raises(ValueError, match="query overlap"):
    assert_no_query_overlap(dataset.cases, [prior])


def test_task049_dataset_rejects_short_seed_and_unknown_split():
  with pytest.raises(ValueError, match="32 bytes"):
    generate_dataset(b"short", split="calibration")
  with pytest.raises(ValueError, match="split"):
    generate_dataset(bytes.fromhex("55" * 32), split="holdout")
