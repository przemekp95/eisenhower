#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import argparse
from datetime import datetime
import hashlib
import json
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.evaluation import evaluation_governance_issues, freeze_evaluation_candidate
from app.artifacts.registry import write_private_bytes


def _timestamp(value: object, field: str) -> datetime:
  try:
    resolved = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
  except ValueError as issue:
    raise ValueError(f"{field} must be a timezone-aware ISO-8601 timestamp.") from issue
  if resolved.tzinfo is None or resolved.utcoffset() is None:
    raise ValueError(f"{field} must be a timezone-aware ISO-8601 timestamp.")
  return resolved


def validate_evidence_manifest(
  path: Path,
  candidate_bytes: bytes,
  manifest_bytes: bytes | None = None,
) -> dict:
  manifest = json.loads(manifest_bytes if manifest_bytes is not None else path.read_bytes())
  if not isinstance(manifest, dict) or manifest.get("schema_version") != "annotation-evidence/v1":
    raise ValueError("Annotation evidence manifest has an unsupported schema.")
  candidate = manifest.get("candidate")
  if not isinstance(candidate, dict):
    raise ValueError("Annotation evidence manifest is missing candidate evidence.")
  expected = hashlib.sha256(candidate_bytes).hexdigest()
  if candidate.get("sha256") != expected:
    raise ValueError("Annotation evidence candidate digest does not match the input candidate.")
  files = manifest.get("files")
  adjudicator = manifest.get("adjudicator")
  if not isinstance(files, dict) or not isinstance(adjudicator, dict):
    raise ValueError("Annotation evidence manifest has invalid file roles or adjudication metadata.")
  required_roles = {
    "pool", "guide", "coverage_manifest", "annotator_a", "annotator_b", "agreement_report"
  }
  if adjudicator.get("required") is True:
    required_roles.add("adjudication")
  if set(files) != required_roles:
    raise ValueError("Annotation evidence manifest file roles do not match the adjudication state.")
  for role, reference in files.items():
    if not isinstance(reference, dict):
      raise ValueError(f"Annotation evidence file role {role!r} is invalid.")
    name = str(reference.get("name", ""))
    digest = str(reference.get("sha256", ""))
    if Path(name).name != name or not name:
      raise ValueError(f"Annotation evidence file role {role!r} has an invalid name.")
    if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
      raise ValueError(f"Annotation evidence file role {role!r} has an invalid digest.")
  candidate_payload = json.loads(candidate_bytes)
  evidence = candidate_payload.get("governance", {}).get("annotation_evidence")
  if not isinstance(evidence, dict):
    raise ValueError("Candidate is missing annotation evidence.")
  disagreement_ids = evidence.get("disagreement_ids")
  if not isinstance(disagreement_ids, list):
    raise ValueError("Candidate disagreement evidence is invalid.")
  if adjudicator.get("required") is not bool(disagreement_ids):
    raise ValueError("Manifest adjudication does not match candidate disagreement evidence.")
  if adjudicator.get("decision_count") != len(disagreement_ids):
    raise ValueError("Manifest adjudication count does not match candidate disagreement evidence.")
  agreement = manifest.get("agreement")
  if not isinstance(agreement, dict) or (
    agreement.get("raw_agreement") != evidence.get("raw_agreement")
    or agreement.get("cohen_kappa") != evidence.get("cohen_kappa")
    or agreement.get("disagreement_count") != len(disagreement_ids)
  ):
    raise ValueError("Manifest agreement does not match candidate disagreement evidence.")
  digest_roles = {
    "pool": "pool_sha256",
    "annotator_a": "annotator_a_sha256",
    "annotator_b": "annotator_b_sha256",
  }
  if any(files[role]["sha256"] != evidence.get(field) for role, field in digest_roles.items()):
    raise ValueError("Manifest input digests do not match candidate annotation evidence.")
  _timestamp(manifest.get("measured_at"), "measured_at")
  return manifest


def main() -> int:
  parser = argparse.ArgumentParser(
    description="Freeze a measured candidate after an explicit named human approval."
  )
  parser.add_argument("--input", type=Path, required=True)
  parser.add_argument("--evidence-manifest", type=Path, required=True)
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument("--manifest", type=Path, required=True)
  parser.add_argument("--approver-id", required=True)
  parser.add_argument("--approved-at", required=True, help="Human approval timestamp, preferably ISO-8601 UTC.")
  args = parser.parse_args()

  try:
    candidate_bytes = args.input.read_bytes()
    candidate = json.loads(candidate_bytes)
    evidence_manifest_bytes = args.evidence_manifest.read_bytes()
    evidence_manifest = validate_evidence_manifest(
      args.evidence_manifest,
      candidate_bytes,
      evidence_manifest_bytes,
    )
    if evidence_manifest["candidate"].get("name") != args.input.name:
      raise ValueError("Annotation evidence candidate name does not match the input candidate.")
    evidence_manifest_digest = hashlib.sha256(evidence_manifest_bytes).hexdigest()
    annotation_evidence = candidate.get("governance", {}).get("annotation_evidence")
    if not isinstance(annotation_evidence, dict):
      raise ValueError("Candidate is missing annotation evidence.")
    approval_time = _timestamp(args.approved_at, "approved_at")
    chronology_anchor = (
      evidence_manifest["adjudicator"].get("completed_at")
      if evidence_manifest["adjudicator"].get("required") is True
      else evidence_manifest.get("measured_at")
    )
    if approval_time < _timestamp(chronology_anchor, "chronology_anchor"):
      raise ValueError("Human approval must occur after measurement and adjudication are complete.")
    annotation_evidence["evidence_manifest_sha256"] = evidence_manifest_digest
    frozen = freeze_evaluation_candidate(
      candidate,
      approver_id=args.approver_id,
      approved_at=args.approved_at,
    )
    governance_issues = evaluation_governance_issues(frozen, profile="production")
    if governance_issues:
      raise ValueError(f"production governance issues remain: {governance_issues}")
  except (OSError, ValueError, json.JSONDecodeError) as issue:
    print(f"evaluation-freeze-blocked: {issue}", file=sys.stderr)
    return 2

  serialized = json.dumps(frozen, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
  digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
  manifest = {
    "dataset_name": frozen["name"],
    "dataset_sha256": digest,
    "examples": len(frozen["examples"]),
    "approved_by": frozen["governance"]["approved_by"],
    "approved_at": frozen["governance"]["approved_at"],
    "label_contract": frozen["label_contract"],
    "annotation_evidence_manifest_sha256": evidence_manifest_digest,
  }
  if args.output.exists() or args.manifest.exists():
    print("evaluation-freeze-blocked: outputs are immutable and must not already exist.", file=sys.stderr)
    return 2
  write_private_bytes(args.output, serialized.encode("utf-8"))
  write_private_bytes(
    args.manifest,
    (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"),
  )
  print(json.dumps({"status": "approved-frozen", **manifest}, ensure_ascii=False))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
