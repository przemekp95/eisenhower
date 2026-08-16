#!/usr/bin/env python3
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any
import argparse
import hashlib
import json
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.evaluation import annotation_agreement
from app.artifacts.registry import write_private_bytes


FILE_KEYS = ("pool", "guide", "coverage_manifest", "annotator_a", "annotator_b")


def load_jsonl(path: Path) -> list[dict[str, Any]]:
  return parse_jsonl(path.read_bytes(), str(path))


def parse_jsonl(data: bytes, source: str) -> list[dict[str, Any]]:
  rows: list[dict[str, Any]] = []
  for line_number, raw_line in enumerate(data.decode("utf-8").splitlines(), start=1):
    if not raw_line.strip():
      continue
    row = json.loads(raw_line)
    if not isinstance(row, dict):
      raise ValueError(f"{source}:{line_number} must contain a JSON object.")
    rows.append(row)
  if not rows:
    raise ValueError(f"{source} is empty.")
  return rows


def load_decisions(path: Path) -> dict[str, int]:
  return parse_decisions(path.read_bytes(), str(path))


def parse_decisions(data: bytes, source: str) -> dict[str, int]:
  decisions: dict[str, int] = {}
  for row in parse_jsonl(data, source):
    example_id = str(row.get("id", "")).strip()
    quadrant = row.get("quadrant")
    if not example_id or example_id in decisions:
      raise ValueError(f"{source} must contain unique non-empty ids.")
    if not isinstance(quadrant, int) or isinstance(quadrant, bool) or quadrant not in range(4):
      raise ValueError(f"{source}:{example_id} requires a human quadrant integer in range 0..3.")
    decisions[example_id] = quadrant
  return decisions


def sha256(path: Path) -> str:
  return hashlib.sha256(path.read_bytes()).hexdigest()


def file_evidence(path: Path, data: bytes | None = None) -> dict[str, str]:
  digest = hashlib.sha256(data).hexdigest() if data is not None else sha256(path)
  return {"name": path.name, "sha256": digest}


def bytes_evidence(path: Path, data: bytes) -> dict[str, str]:
  return {"name": path.name, "sha256": hashlib.sha256(data).hexdigest()}


def _require_timestamp(value: str, field_name: str) -> str:
  resolved = str(value).strip()
  try:
    parsed = datetime.fromisoformat(resolved.replace("Z", "+00:00"))
  except ValueError as issue:
    raise ValueError(f"{field_name} must be a timezone-aware ISO-8601 timestamp.") from issue
  if parsed.tzinfo is None or parsed.utcoffset() is None:
    raise ValueError(f"{field_name} must be a timezone-aware ISO-8601 timestamp.")
  return resolved


def _require_files(files: dict[str, dict[str, str]]) -> dict[str, dict[str, str]]:
  if set(files) != set(FILE_KEYS):
    raise ValueError(f"Agreement evidence must bind exactly these files: {FILE_KEYS}.")
  resolved: dict[str, dict[str, str]] = {}
  for key in FILE_KEYS:
    item = files[key]
    name = str(item.get("name", "")).strip()
    digest = str(item.get("sha256", "")).strip().lower()
    if not name or Path(name).name != name:
      raise ValueError(f"{key} evidence requires a basename-only file name.")
    if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
      raise ValueError(f"{key} evidence requires a lowercase SHA-256 digest.")
    resolved[key] = {"name": name, "sha256": digest}
  return resolved


def _confusion_matrix(annotator_a: dict[str, int], annotator_b: dict[str, int]) -> list[list[int]]:
  matrix = [[0 for _ in range(4)] for _ in range(4)]
  for example_id in sorted(annotator_a):
    matrix[annotator_a[example_id]][annotator_b[example_id]] += 1
  return matrix


def build_agreement_report(
  pool: list[dict[str, Any]],
  annotator_a: dict[str, int],
  annotator_b: dict[str, int],
  *,
  packet_version: str,
  annotator_a_id: str,
  annotator_a_completed_at: str,
  annotator_b_id: str,
  annotator_b_completed_at: str,
  measured_at: str,
  files: dict[str, dict[str, str]],
) -> dict[str, Any]:
  version = str(packet_version).strip()
  pseudonym_a = str(annotator_a_id).strip()
  pseudonym_b = str(annotator_b_id).strip()
  if not version:
    raise ValueError("A non-empty packet version is required.")
  if not pseudonym_a or not pseudonym_b or pseudonym_a == pseudonym_b:
    raise ValueError("Agreement evidence requires two distinct human pseudonyms.")

  languages: dict[str, str] = {}
  for item in pool:
    example_id = str(item.get("id", "")).strip()
    language = str(item.get("language", "")).strip()
    if not example_id or example_id in languages:
      raise ValueError("Annotation pool ids must be present and unique.")
    if language not in {"en", "pl"}:
      raise ValueError("Annotation pool language must be 'en' or 'pl'.")
    languages[example_id] = language
  if set(annotator_a) != set(languages) or set(annotator_b) != set(languages):
    raise ValueError("Both annotation files must cover every pool id exactly once.")

  by_language: dict[str, dict[str, Any]] = {}
  for language in ("en", "pl"):
    ids = sorted(example_id for example_id, value in languages.items() if value == language)
    if not ids:
      raise ValueError(f"Annotation pool has no {language!r} examples.")
    by_language[language] = annotation_agreement(
      {example_id: annotator_a[example_id] for example_id in ids},
      {example_id: annotator_b[example_id] for example_id in ids},
    )

  agreement = annotation_agreement(annotator_a, annotator_b)
  gate_reasons = []
  if float(agreement["raw_agreement"]) < 0.80:
    gate_reasons.append("raw_agreement_below_0.80")
  if float(agreement["cohen_kappa"]) < 0.80:
    gate_reasons.append("cohen_kappa_below_0.80")
  resolved_a_completed = _require_timestamp(annotator_a_completed_at, "annotator_a_completed_at")
  resolved_b_completed = _require_timestamp(annotator_b_completed_at, "annotator_b_completed_at")
  resolved_measured = _require_timestamp(measured_at, "measured_at")
  completed_times = [
    datetime.fromisoformat(value.replace("Z", "+00:00"))
    for value in (resolved_a_completed, resolved_b_completed)
  ]
  if datetime.fromisoformat(resolved_measured.replace("Z", "+00:00")) < max(completed_times):
    raise ValueError("Agreement measurement must occur after both blind passes are complete.")
  return {
    "schema_version": "annotation-agreement/v1",
    "stage": "pre-adjudication",
    "packet_version": version,
    "measured_at": resolved_measured,
    "files": _require_files(files),
    "annotators": {
      "a": {
        "pseudonym": pseudonym_a,
        "completed_at": resolved_a_completed,
      },
      "b": {
        "pseudonym": pseudonym_b,
        "completed_at": resolved_b_completed,
      },
    },
    "agreement": agreement,
    "by_language": by_language,
    "confusion_matrix": _confusion_matrix(annotator_a, annotator_b),
    "gate": {"passed": not gate_reasons, "reasons": gate_reasons},
  }


def main() -> int:
  parser = argparse.ArgumentParser(
    description="Freeze two blind human passes and their agreement before adjudication."
  )
  parser.add_argument("--pool", type=Path, required=True)
  parser.add_argument("--guide", type=Path, required=True)
  parser.add_argument("--coverage-manifest", type=Path, required=True)
  parser.add_argument("--annotator-a", type=Path, required=True)
  parser.add_argument("--annotator-b", type=Path, required=True)
  parser.add_argument("--annotator-a-id", required=True)
  parser.add_argument("--annotator-a-completed-at", required=True)
  parser.add_argument("--annotator-b-id", required=True)
  parser.add_argument("--annotator-b-completed-at", required=True)
  parser.add_argument("--measured-at", required=True)
  parser.add_argument("--packet-version", required=True)
  parser.add_argument("--output", type=Path, required=True)
  args = parser.parse_args()

  try:
    inputs = {
      "pool": args.pool.read_bytes(),
      "guide": args.guide.read_bytes(),
      "coverage_manifest": args.coverage_manifest.read_bytes(),
      "annotator_a": args.annotator_a.read_bytes(),
      "annotator_b": args.annotator_b.read_bytes(),
    }
    pool = parse_jsonl(inputs["pool"], str(args.pool))
    annotator_a = parse_decisions(inputs["annotator_a"], str(args.annotator_a))
    annotator_b = parse_decisions(inputs["annotator_b"], str(args.annotator_b))
    report = build_agreement_report(
      pool,
      annotator_a,
      annotator_b,
      packet_version=args.packet_version,
      annotator_a_id=args.annotator_a_id,
      annotator_a_completed_at=args.annotator_a_completed_at,
      annotator_b_id=args.annotator_b_id,
      annotator_b_completed_at=args.annotator_b_completed_at,
      measured_at=args.measured_at,
      files={
        "pool": bytes_evidence(args.pool, inputs["pool"]),
        "guide": bytes_evidence(args.guide, inputs["guide"]),
        "coverage_manifest": bytes_evidence(args.coverage_manifest, inputs["coverage_manifest"]),
        "annotator_a": bytes_evidence(args.annotator_a, inputs["annotator_a"]),
        "annotator_b": bytes_evidence(args.annotator_b, inputs["annotator_b"]),
      },
    )
    serialized = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    write_private_bytes(args.output, serialized.encode("utf-8"))
  except (OSError, ValueError, json.JSONDecodeError) as issue:
    print(f"annotation-agreement-blocked: {issue}", file=sys.stderr)
    return 2

  print(
    json.dumps(
      {
        "status": "pre-adjudication-agreement-frozen",
        "output": str(args.output),
        "sha256": hashlib.sha256(serialized.encode("utf-8")).hexdigest(),
        "raw_agreement": report["agreement"]["raw_agreement"],
        "cohen_kappa": report["agreement"]["cohen_kappa"],
        "disagreements": len(report["agreement"]["disagreement_ids"]),
      },
      ensure_ascii=False,
    )
  )
  return 0 if report["gate"]["passed"] else 2


if __name__ == "__main__":
  raise SystemExit(main())
