#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from typing import Any
import argparse
from datetime import datetime
import hashlib
import json
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.evaluation import finalize_dual_annotations
from app.artifacts.registry import write_private_bytes
from scripts.measure_annotation_agreement import (
  build_agreement_report,
  file_evidence,
  parse_decisions,
  parse_jsonl,
  _require_timestamp,
)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
  rows: list[dict[str, Any]] = []
  for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
    if not raw_line.strip():
      continue
    row = json.loads(raw_line)
    if not isinstance(row, dict):
      raise ValueError(f"{path}:{line_number} must contain a JSON object.")
    rows.append(row)
  if not rows:
    raise ValueError(f"{path} is empty.")
  return rows


def load_decisions(path: Path) -> dict[str, int]:
  decisions: dict[str, int] = {}
  for row in load_jsonl(path):
    example_id = str(row.get("id", "")).strip()
    quadrant = row.get("quadrant")
    if not example_id or example_id in decisions:
      raise ValueError(f"{path} must contain unique non-empty ids.")
    if not isinstance(quadrant, int) or isinstance(quadrant, bool) or quadrant not in range(4):
      raise ValueError(f"{path}:{example_id} requires a human quadrant integer in range 0..3.")
    decisions[example_id] = quadrant
  return decisions


def load_adjudication(path: Path, data: bytes | None = None) -> dict[str, int]:
  decisions: dict[str, int] = {}
  rows = parse_jsonl(data, str(path)) if data is not None else load_jsonl(path)
  for row in rows:
    example_id = str(row.get("id", "")).strip()
    quadrant = row.get("quadrant")
    rationale = str(row.get("rationale", "")).strip()
    if not example_id or example_id in decisions:
      raise ValueError(f"{path} must contain unique non-empty ids.")
    if not isinstance(quadrant, int) or isinstance(quadrant, bool) or quadrant not in range(4):
      raise ValueError(f"{path}:{example_id} requires a human quadrant integer in range 0..3.")
    if not rationale:
      raise ValueError(f"{path}:{example_id} requires a non-empty rationale.")
    decisions[example_id] = quadrant
  return decisions


def validate_agreement_report(
  path: Path,
  *,
  pool: list[dict[str, Any]],
  annotator_a: dict[str, int],
  annotator_b: dict[str, int],
  expected_files: dict[str, dict[str, str]],
  report_bytes: bytes | None = None,
) -> dict[str, Any]:
  report = json.loads(report_bytes if report_bytes is not None else path.read_bytes())
  if not isinstance(report, dict):
    raise ValueError("Agreement report must contain a JSON object.")
  annotators = report.get("annotators")
  if not isinstance(annotators, dict) or not isinstance(annotators.get("a"), dict) or not isinstance(annotators.get("b"), dict):
    raise ValueError("Agreement report has invalid annotator metadata.")
  rebuilt = build_agreement_report(
    pool,
    annotator_a,
    annotator_b,
    packet_version=str(report.get("packet_version", "")),
    annotator_a_id=str(annotators["a"].get("pseudonym", "")),
    annotator_a_completed_at=str(annotators["a"].get("completed_at", "")),
    annotator_b_id=str(annotators["b"].get("pseudonym", "")),
    annotator_b_completed_at=str(annotators["b"].get("completed_at", "")),
    measured_at=str(report.get("measured_at", "")),
    files=expected_files,
  )
  if report.get("files") != expected_files or report != rebuilt:
    raise ValueError("Agreement report does not match the exact frozen input files and decisions.")
  return report


def build_evidence_manifest(
  report: dict[str, Any],
  *,
  agreement_path: Path,
  adjudication_path: Path | None,
  adjudicator_id: str | None,
  adjudicated_at: str | None,
  candidate_name: str,
  candidate_bytes: bytes,
  agreement_bytes: bytes | None = None,
  adjudication_bytes: bytes | None = None,
) -> dict[str, Any]:
  disagreements = list(report["agreement"]["disagreement_ids"])
  resolved_name = Path(candidate_name).name
  if not resolved_name or resolved_name != candidate_name:
    raise ValueError("Candidate evidence requires a basename-only file name.")
  if disagreements:
    pseudonym = str(adjudicator_id or "").strip()
    if adjudication_path is None or not pseudonym or not adjudicated_at:
      raise ValueError("Disagreements require adjudication evidence, a pseudonym and timestamp.")
    adjudication_evidence: dict[str, Any] = {
      "required": True,
      "pseudonym": pseudonym,
      "completed_at": _require_timestamp(adjudicated_at, "adjudicated_at"),
      "decision_count": len(disagreements),
    }
    measured_time = datetime.fromisoformat(report["measured_at"].replace("Z", "+00:00"))
    adjudicated_time = datetime.fromisoformat(
      adjudication_evidence["completed_at"].replace("Z", "+00:00")
    )
    if adjudicated_time < measured_time:
      raise ValueError("Adjudication must occur after the frozen agreement measurement.")
    adjudication_file = file_evidence(adjudication_path, adjudication_bytes)
  else:
    if adjudication_path is not None or adjudicator_id or adjudicated_at:
      raise ValueError("Adjudication evidence must be absent when there are no disagreements.")
    adjudication_evidence = {"required": False, "decision_count": 0}
    adjudication_file = None

  files = {
    **report["files"],
    "agreement_report": file_evidence(agreement_path, agreement_bytes),
  }
  if adjudication_file is not None:
    files["adjudication"] = adjudication_file
  return {
    "schema_version": "annotation-evidence/v1",
    "packet_version": report["packet_version"],
    "measured_at": report["measured_at"],
    "files": files,
    "annotators": report["annotators"],
    "adjudicator": adjudication_evidence,
    "agreement": {
      "raw_agreement": report["agreement"]["raw_agreement"],
      "cohen_kappa": report["agreement"]["cohen_kappa"],
      "disagreement_count": len(disagreements),
    },
    "candidate": {
      "name": resolved_name,
      "sha256": hashlib.sha256(candidate_bytes).hexdigest(),
    },
  }


def main() -> int:
  parser = argparse.ArgumentParser(
    description="Measure two blind human annotations and build a pending evaluation candidate."
  )
  parser.add_argument("--pool", type=Path, required=True)
  parser.add_argument("--guide", type=Path, required=True)
  parser.add_argument("--coverage-manifest", type=Path, required=True)
  parser.add_argument("--annotator-a", type=Path, required=True)
  parser.add_argument("--annotator-b", type=Path, required=True)
  parser.add_argument("--adjudication", type=Path)
  parser.add_argument("--adjudicator-id")
  parser.add_argument("--adjudicated-at")
  parser.add_argument("--agreement-report", type=Path, required=True)
  parser.add_argument("--output", "--candidate-output", dest="output", type=Path, required=True)
  parser.add_argument("--manifest-output", type=Path, required=True)
  parser.add_argument("--dataset-name", required=True)
  args = parser.parse_args()

  try:
    input_bytes = {
      "pool": args.pool.read_bytes(),
      "guide": args.guide.read_bytes(),
      "coverage_manifest": args.coverage_manifest.read_bytes(),
      "annotator_a": args.annotator_a.read_bytes(),
      "annotator_b": args.annotator_b.read_bytes(),
      "agreement_report": args.agreement_report.read_bytes(),
    }
    if args.adjudication:
      input_bytes["adjudication"] = args.adjudication.read_bytes()
    pool = parse_jsonl(input_bytes["pool"], str(args.pool))
    annotator_a = parse_decisions(input_bytes["annotator_a"], str(args.annotator_a))
    annotator_b = parse_decisions(input_bytes["annotator_b"], str(args.annotator_b))
    expected_files = {
      "pool": file_evidence(args.pool, input_bytes["pool"]),
      "guide": file_evidence(args.guide, input_bytes["guide"]),
      "coverage_manifest": file_evidence(args.coverage_manifest, input_bytes["coverage_manifest"]),
      "annotator_a": file_evidence(args.annotator_a, input_bytes["annotator_a"]),
      "annotator_b": file_evidence(args.annotator_b, input_bytes["annotator_b"]),
    }
    report = validate_agreement_report(
      args.agreement_report,
      pool=pool,
      annotator_a=annotator_a,
      annotator_b=annotator_b,
      expected_files=expected_files,
      report_bytes=input_bytes["agreement_report"],
    )
    if float(report["agreement"]["raw_agreement"]) < 0.80 or float(report["agreement"]["cohen_kappa"]) < 0.80:
      raise ValueError("The frozen pre-adjudication agreement gate did not pass.")
    adjudication = (
      load_adjudication(args.adjudication, input_bytes["adjudication"])
      if args.adjudication else {}
    )
    candidate = finalize_dual_annotations(
      pool,
      annotator_a,
      annotator_b,
      adjudication=adjudication,
      dataset_name=args.dataset_name,
      annotator_a_sha256=expected_files["annotator_a"]["sha256"],
      annotator_b_sha256=expected_files["annotator_b"]["sha256"],
      pool_sha256=expected_files["pool"]["sha256"],
    )
    serialized = json.dumps(candidate, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    manifest = build_evidence_manifest(
      report,
      agreement_path=args.agreement_report,
      adjudication_path=args.adjudication,
      adjudicator_id=args.adjudicator_id,
      adjudicated_at=args.adjudicated_at,
      candidate_name=args.output.name,
      candidate_bytes=serialized.encode("utf-8"),
      agreement_bytes=input_bytes["agreement_report"],
      adjudication_bytes=input_bytes.get("adjudication"),
    )
    if args.output.exists() or args.manifest_output.exists():
      raise ValueError("Candidate and evidence outputs are immutable and must not already exist.")
    write_private_bytes(args.output, serialized.encode("utf-8"))
    write_private_bytes(
      args.manifest_output,
      (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"),
    )
  except (OSError, ValueError, json.JSONDecodeError) as issue:
    print(f"annotation-finalization-blocked: {issue}", file=sys.stderr)
    return 2

  evidence = candidate["governance"]["annotation_evidence"]
  print(
    json.dumps(
      {
        "status": candidate["governance"]["status"],
        "output": str(args.output),
        "evidence_manifest": str(args.manifest_output),
        "examples": len(candidate["examples"]),
        "raw_agreement": evidence["raw_agreement"],
        "cohen_kappa": evidence["cohen_kappa"],
        "disagreements": len(evidence["disagreement_ids"]),
      },
      ensure_ascii=False,
    )
  )
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
