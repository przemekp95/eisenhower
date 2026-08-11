from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta
from hashlib import sha256
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .corpus_manifest import CorpusManifest, RepositoryCorpusConnector
from .golden import GoldenCase, parse_golden_dataset
from .models import AccessScope


HUMAN_ATTESTED_DATASET_VERSION = "retrieval-golden-v1-human-attested"
REVIEW_SCHEMA_VERSION = "retrieval-human-review-v1"
_PROTECTED_CORRECTION_FIELDS = (
  "case_id",
  "tenant_id",
  "user_id",
  "project_ids",
  "query_project_id",
  "roles",
  "language",
  "split",
  "task",
  "corpus_version",
  "index_version",
)
_ZERO_TOLERANCE_THRESHOLDS = {
  ("global", "stale_hit_rate_max"),
  ("global", "forbidden_hit_rate_max"),
  ("global", "isolation_violation_rate_max"),
}


class StrictReviewModel(BaseModel):
  model_config = ConfigDict(extra="forbid")


class ReviewDecision(StrictReviewModel):
  case_id: str = Field(..., min_length=1, max_length=128)
  outcome: Literal["APPROVED", "CORRECTED"]
  correction: GoldenCase | None = None

  @model_validator(mode="after")
  def correction_matches_outcome(self):
    if (self.outcome == "CORRECTED") != (self.correction is not None):
      raise ValueError("CORRECTED requires one complete replacement; APPROVED forbids it")
    return self


class HumanReviewRecord(StrictReviewModel):
  schema_version: Literal[REVIEW_SCHEMA_VERSION]
  candidate_sha256: str = Field(..., pattern=r"^[a-f0-9]{64}$")
  threshold_proposal_sha256: str = Field(..., pattern=r"^[a-f0-9]{64}$")
  corpus_manifest_sha256: str = Field(..., pattern=r"^[a-f0-9]{64}$")
  corpus_snapshot_sha256: str = Field(..., pattern=r"^[a-f0-9]{64}$")
  reviewer_id: str = Field(..., min_length=1, max_length=128)
  completed_at: datetime
  independent_human_review: Literal[True]
  no_private_data_exposed: Literal[True]
  labels_decision: Literal["APPROVED", "CORRECTED"]
  thresholds_decision: Literal["APPROVED", "CORRECTED"]
  decisions: list[ReviewDecision] = Field(..., min_length=1)
  final_thresholds: dict
  reviewer_attestation: Literal[
    "I independently reviewed every case against the frozen sources and approve this record."
  ]

  @model_validator(mode="after")
  def timestamps_and_summary_are_consistent(self):
    if self.completed_at.tzinfo is None or self.completed_at.utcoffset() != timedelta(0):
      raise ValueError("completed_at must use UTC")
    corrected = any(item.outcome == "CORRECTED" for item in self.decisions)
    if corrected != (self.labels_decision == "CORRECTED"):
      raise ValueError("labels_decision must summarize the per-case outcomes")
    return self


def bytes_sha256(content: bytes) -> str:
  return sha256(content).hexdigest()


def _json_from_bytes(content: bytes, label: str):
  try:
    return json.loads(content.decode("utf-8"))
  except (UnicodeDecodeError, json.JSONDecodeError) as error:
    raise ValueError(f"{label} must be valid UTF-8 JSON") from error


def build_review_template(
  candidate_path: Path,
  thresholds_path: Path,
  manifest_path: Path,
) -> dict:
  candidate_bytes = candidate_path.read_bytes()
  thresholds_bytes = thresholds_path.read_bytes()
  manifest_bytes = manifest_path.read_bytes()
  cases = parse_golden_dataset(candidate_bytes.decode("utf-8"))
  thresholds = _json_from_bytes(thresholds_bytes, "threshold proposal")
  manifest = _json_from_bytes(manifest_bytes, "corpus manifest")
  final_thresholds = {
    key: value
    for key, value in thresholds.items()
    if key not in {"dataset_version", "approval_status", "notes"}
  }
  return {
    "schema_version": REVIEW_SCHEMA_VERSION,
    "candidate_sha256": bytes_sha256(candidate_bytes),
    "threshold_proposal_sha256": bytes_sha256(thresholds_bytes),
    "corpus_manifest_sha256": bytes_sha256(manifest_bytes),
    "corpus_snapshot_sha256": manifest["initial_snapshot"]["sha256"],
    "reviewer_id": "PENDING",
    "completed_at": "PENDING",
    "independent_human_review": False,
    "no_private_data_exposed": False,
    "labels_decision": "PENDING",
    "thresholds_decision": "PENDING",
    "decisions": [
      {"case_id": case.case_id, "outcome": "PENDING", "correction": None}
      for case in cases
    ],
    "final_thresholds": final_thresholds,
    "reviewer_attestation": "PENDING",
  }


def finalize_human_review(
  candidate_path: Path,
  thresholds_path: Path,
  manifest_path: Path,
  review_path: Path,
) -> tuple[list[GoldenCase], dict]:
  candidate_bytes = candidate_path.read_bytes()
  thresholds_bytes = thresholds_path.read_bytes()
  manifest_bytes = manifest_path.read_bytes()
  review_bytes = review_path.read_bytes()
  raw_review = _json_from_bytes(review_bytes, "human review")
  if _contains_pending(raw_review):
    raise ValueError("human review still contains PENDING fields")
  review = HumanReviewRecord.model_validate(raw_review)
  manifest_data = _json_from_bytes(manifest_bytes, "corpus manifest")
  _verify_bound_hashes(
    review,
    candidate_bytes=candidate_bytes,
    thresholds_bytes=thresholds_bytes,
    manifest_bytes=manifest_bytes,
    manifest=manifest_data,
  )

  candidate = parse_golden_dataset(candidate_bytes.decode("utf-8"))
  candidate_by_id = {case.case_id: case for case in candidate}
  decisions = {item.case_id: item for item in review.decisions}
  if len(decisions) != len(review.decisions):
    raise ValueError("human review case ids must be unique")
  if set(decisions) != set(candidate_by_id):
    raise ValueError("human review must decide every and only candidate case")

  manifest = CorpusManifest.model_validate_json(manifest_bytes)
  repository_root = manifest_path.resolve().parents[2]
  approved_documents = _approved_document_contract(repository_root, manifest)
  frozen = []
  corrections = 0
  for case in candidate:
    decision = decisions[case.case_id]
    selected = case
    if decision.correction is not None:
      _validate_correction(case, decision.correction)
      selected = decision.correction
      corrections += 1
    _validate_source_labels(selected, approved_documents)
    frozen.append(selected.model_copy(update={"dataset_version": HUMAN_ATTESTED_DATASET_VERSION}))

  proposal = _json_from_bytes(thresholds_bytes, "threshold proposal")
  thresholds = _validate_thresholds(review.final_thresholds, proposal)
  thresholds_changed = thresholds != {
    key: value
    for key, value in proposal.items()
    if key not in {"dataset_version", "approval_status", "notes"}
  }
  if thresholds_changed != (review.thresholds_decision == "CORRECTED"):
    raise ValueError("thresholds_decision must match whether final thresholds changed")
  serialized = _serialize_dataset(frozen)
  review_sha = bytes_sha256(review_bytes)
  dataset_sha = sha256(serialized.encode("utf-8")).hexdigest()
  counts = Counter((case.split, case.language) for case in frozen)
  approval_manifest = {
    "schema_version": "retrieval-golden-approval-v1",
    "approval_status": "human_attestation_recorded_frozen",
    "provenance_status": "self_attested_not_cryptographically_verified",
    "task_gate_status": "requires_out_of_band_human_provenance_confirmation",
    "dataset_version": HUMAN_ATTESTED_DATASET_VERSION,
    "dataset_sha256": dataset_sha,
    "case_count": len(frozen),
    "case_counts": {
      f"{split}_{language}": count
      for (split, language), count in sorted(counts.items())
    },
    "candidate_sha256": review.candidate_sha256,
    "threshold_proposal_sha256": review.threshold_proposal_sha256,
    "corpus_manifest_sha256": review.corpus_manifest_sha256,
    "corpus_snapshot_sha256": review.corpus_snapshot_sha256,
    "human_review_sha256": review_sha,
    "reviewer_id": review.reviewer_id,
    "completed_at": review.completed_at.isoformat(),
    "labels_decision": review.labels_decision,
    "thresholds_decision": review.thresholds_decision,
    "correction_count": corrections,
    "final_thresholds": thresholds,
    "holdout_policy": "immutable_after_human_freeze; never tune on holdout",
  }
  return frozen, approval_manifest


def serialize_dataset(cases: list[GoldenCase]) -> str:
  return _serialize_dataset(cases)


def _contains_pending(value) -> bool:
  if isinstance(value, str):
    return value.strip().upper().startswith("PENDING")
  if isinstance(value, list):
    return any(_contains_pending(item) for item in value)
  if isinstance(value, dict):
    return any(_contains_pending(item) for item in value.values())
  return False


def _verify_bound_hashes(
  review: HumanReviewRecord,
  *,
  candidate_bytes: bytes,
  thresholds_bytes: bytes,
  manifest_bytes: bytes,
  manifest: dict,
) -> None:
  checks = (
    ("candidate", review.candidate_sha256, bytes_sha256(candidate_bytes)),
    ("threshold proposal", review.threshold_proposal_sha256, bytes_sha256(thresholds_bytes)),
    ("corpus manifest", review.corpus_manifest_sha256, bytes_sha256(manifest_bytes)),
    (
      "corpus snapshot",
      review.corpus_snapshot_sha256,
      str(manifest["initial_snapshot"]["sha256"]),
    ),
  )
  drifted = [label for label, expected, actual in checks if expected != actual]
  if drifted:
    raise ValueError(f"human review input hash drift detected: {', '.join(drifted)}")


def _approved_document_contract(
  repository_root: Path,
  manifest: CorpusManifest,
) -> dict[str, str]:
  connector = RepositoryCorpusConnector(repository_root, manifest)
  documents = connector.load_initial(
    AccessScope(
      tenant_id=manifest.identity_and_acl.initial_tenant,
      user_id="human-review-snapshot-verifier",
      project_ids=["human-review-snapshot-verifier"],
    )
  )
  return {document.document_id: document.content_version for document in documents}


def _validate_correction(original: GoldenCase, correction: GoldenCase) -> None:
  for field in _PROTECTED_CORRECTION_FIELDS:
    if getattr(original, field) != getattr(correction, field):
      raise ValueError(f"human correction cannot change protected field {field}")
  if original.answerability == "no_answer" and correction.answerability != "no_answer":
    raise ValueError("a predeclared no-answer security probe cannot become answerable")
  if original.answerability == "no_answer" and not set(original.forbidden_document_ids).issubset(
    correction.forbidden_document_ids
  ):
    raise ValueError("a no-answer security probe cannot remove frozen forbidden sources")
  isolation_tags = {"no-hit", "privacy", "tenant-isolation", "project-isolation"}
  frozen_tags = set(original.tags) & isolation_tags
  if not frozen_tags.issubset(correction.tags):
    raise ValueError("a security probe cannot remove its frozen risk tags")


def _validate_source_labels(case: GoldenCase, approved_documents: dict[str, str]) -> None:
  labeled_ids = set(
    case.relevant_document_ids
    + case.forbidden_document_ids
    + case.stale_document_ids
  )
  unknown = labeled_ids - set(approved_documents)
  if unknown:
    raise ValueError(f"human review references documents outside the frozen corpus: {sorted(unknown)}")
  expected = set(case.relevant_document_ids)
  if set(case.expected_content_versions) != expected:
    raise ValueError("expected_content_versions must cover exactly the relevant documents")
  if any(case.expected_content_versions[item] != approved_documents[item] for item in expected):
    raise ValueError("human review content version does not match the frozen corpus")


def _validate_thresholds(final: dict, proposal: dict) -> dict:
  expected = {
    key: value
    for key, value in proposal.items()
    if key not in {"dataset_version", "approval_status", "notes"}
  }
  if _shape(final) != _shape(expected):
    raise ValueError("final thresholds must preserve the complete proposal shape")
  if final["k"] != expected["k"]:
    raise ValueError("changing k requires a new measured candidate")
  for path in (
    ("latency_observation", "metric"),
    ("latency_observation", "acceptance_scope"),
  ):
    final_value = final
    expected_value = expected
    for segment in path:
      final_value = final_value[segment]
      expected_value = expected_value[segment]
    if final_value != expected_value:
      raise ValueError(f"threshold metadata {'.'.join(path)} is immutable")
  for path, value in _numeric_leaves(final):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
      raise ValueError(f"threshold {'.'.join(path)} must be numeric")
    if path == ("latency_observation", "proposed_max"):
      if value <= 0:
        raise ValueError("latency reference must be positive")
    elif not 0 <= float(value) <= 1:
      raise ValueError(f"threshold {'.'.join(path)} must be in range 0..1")
  for path in _ZERO_TOLERANCE_THRESHOLDS:
    value = final
    for segment in path:
      value = value[segment]
    if float(value) != 0:
      raise ValueError(f"zero-tolerance threshold {'.'.join(path)} cannot be relaxed")
  return final


def _shape(value):
  if isinstance(value, dict):
    return {key: _shape(item) for key, item in value.items()}
  if isinstance(value, list):
    return [_shape(item) for item in value]
  if isinstance(value, (int, float)) and not isinstance(value, bool):
    return "number"
  return type(value).__name__


def _numeric_leaves(value: dict, prefix: tuple[str, ...] = ()):
  for key, item in value.items():
    path = (*prefix, key)
    if isinstance(item, dict):
      yield from _numeric_leaves(item, path)
    elif isinstance(item, (int, float)) and key not in {"k"}:
      yield path, item


def _serialize_dataset(cases: list[GoldenCase]) -> str:
  return "".join(
    json.dumps(case.model_dump(mode="json"), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    + "\n"
    for case in cases
  )
