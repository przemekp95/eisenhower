import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from app.evaluation import annotation_agreement
from scripts.finalize_annotations import (
  build_evidence_manifest,
  load_adjudication,
  validate_agreement_report,
)
from scripts.freeze_evaluation import validate_evidence_manifest
from scripts.measure_annotation_agreement import build_agreement_report


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def digest(payload: bytes) -> str:
  return hashlib.sha256(payload).hexdigest()


def packet():
  pool = [
    {"id": "en-0", "language": "en", "task": "Urgent incident", "context": "Owner must act."},
    {"id": "en-1", "language": "en", "task": "Route ticket", "context": "Support can act."},
    {"id": "pl-0", "language": "pl", "task": "Pilna awaria", "context": "Właściciel działa."},
    {"id": "pl-1", "language": "pl", "task": "Przekaż zgłoszenie", "context": "Zespół może działać."},
  ]
  annotator_a = {"en-0": 0, "en-1": 1, "pl-0": 0, "pl-1": 1}
  annotator_b = {"en-0": 0, "en-1": 2, "pl-0": 0, "pl-1": 1}
  files = {
    "pool": {"name": "pool.jsonl", "sha256": digest(b"pool")},
    "guide": {"name": "annotation-guide.md", "sha256": digest(b"guide")},
    "coverage_manifest": {"name": "internal-strata.jsonl", "sha256": digest(b"coverage")},
    "annotator_a": {"name": "annotator-a.jsonl", "sha256": digest(b"a")},
    "annotator_b": {"name": "annotator-b.jsonl", "sha256": digest(b"b")},
  }
  return pool, annotator_a, annotator_b, files


def test_build_agreement_report_freezes_pre_adjudication_people_files_and_metrics():
  pool, annotator_a, annotator_b, files = packet()

  report = build_agreement_report(
    pool,
    annotator_a,
    annotator_b,
    packet_version="eisenhower-classifier-production-v1",
    annotator_a_id="human-a",
    annotator_a_completed_at="2026-08-17T08:00:00Z",
    annotator_b_id="human-b",
    annotator_b_completed_at="2026-08-17T09:00:00+00:00",
    measured_at="2026-08-17T09:05:00Z",
    files=files,
  )

  assert report["schema_version"] == "annotation-agreement/v1"
  assert report["stage"] == "pre-adjudication"
  assert report["files"] == files
  assert report["annotators"]["a"]["pseudonym"] == "human-a"
  assert report["annotators"]["b"]["completed_at"] == "2026-08-17T09:00:00+00:00"
  assert report["agreement"] == annotation_agreement(annotator_a, annotator_b)
  assert report["agreement"]["disagreement_ids"] == ["en-1"]
  assert report["by_language"]["en"]["sample_count"] == 2
  assert report["by_language"]["pl"]["raw_agreement"] == 1.0
  assert report["confusion_matrix"][0][0] == 2
  assert report["confusion_matrix"][1][1] == 1
  assert report["confusion_matrix"][1][2] == 1


def test_build_agreement_report_rejects_untraceable_or_non_independent_metadata():
  pool, annotator_a, annotator_b, files = packet()

  with pytest.raises(ValueError, match="distinct human pseudonyms"):
    build_agreement_report(
      pool,
      annotator_a,
      annotator_b,
      packet_version="v1",
      annotator_a_id="same-human",
      annotator_a_completed_at="2026-08-17T08:00:00Z",
      annotator_b_id="same-human",
      annotator_b_completed_at="2026-08-17T09:00:00Z",
      measured_at="2026-08-17T09:05:00Z",
      files=files,
    )

  with pytest.raises(ValueError, match="timezone-aware ISO-8601"):
    build_agreement_report(
      pool,
      annotator_a,
      annotator_b,
      packet_version="v1",
      annotator_a_id="human-a",
      annotator_a_completed_at="2026-08-17 08:00:00",
      annotator_b_id="human-b",
      annotator_b_completed_at="2026-08-17T09:00:00Z",
      measured_at="2026-08-17T09:05:00Z",
      files=files,
    )


def test_finalization_revalidates_report_against_exact_current_inputs(tmp_path: Path):
  pool, annotator_a, annotator_b, files = packet()
  report = build_agreement_report(
    pool,
    annotator_a,
    annotator_b,
    packet_version="v1",
    annotator_a_id="human-a",
    annotator_a_completed_at="2026-08-17T08:00:00Z",
    annotator_b_id="human-b",
    annotator_b_completed_at="2026-08-17T09:00:00Z",
    measured_at="2026-08-17T09:05:00Z",
    files=files,
  )
  report_path = tmp_path / "agreement.json"
  report_path.write_text(json.dumps(report), encoding="utf-8")

  validated = validate_agreement_report(
    report_path,
    pool=pool,
    annotator_a=annotator_a,
    annotator_b=annotator_b,
    expected_files=files,
  )
  assert validated == report

  changed_files = {**files, "guide": {"name": "annotation-guide.md", "sha256": digest(b"changed")}}
  with pytest.raises(ValueError, match="exact frozen input files"):
    validate_agreement_report(
      report_path,
      pool=pool,
      annotator_a=annotator_a,
      annotator_b=annotator_b,
      expected_files=changed_files,
    )


def test_adjudication_requires_a_rationale_for_every_disagreement(tmp_path: Path):
  adjudication = tmp_path / "adjudication.jsonl"
  adjudication.write_text('{"id":"en-1","quadrant":1}\n', encoding="utf-8")

  with pytest.raises(ValueError, match="non-empty rationale"):
    load_adjudication(adjudication)

  adjudication.write_text(
    '{"id":"en-1","quadrant":1,"rationale":"Context makes delegation appropriate."}\n',
    encoding="utf-8",
  )
  assert load_adjudication(adjudication) == {"en-1": 1}


def test_evidence_manifest_binds_candidate_and_all_private_inputs_without_paths(tmp_path: Path):
  pool, annotator_a, annotator_b, files = packet()
  report = build_agreement_report(
    pool,
    annotator_a,
    annotator_b,
    packet_version="v1",
    annotator_a_id="human-a",
    annotator_a_completed_at="2026-08-17T08:00:00Z",
    annotator_b_id="human-b",
    annotator_b_completed_at="2026-08-17T09:00:00Z",
    measured_at="2026-08-17T09:05:00Z",
    files=files,
  )
  agreement_path = tmp_path / "agreement.json"
  agreement_path.write_text(json.dumps(report), encoding="utf-8")
  adjudication_path = tmp_path / "adjudication.jsonl"
  adjudication_path.write_text(
    '{"id":"en-1","quadrant":1,"rationale":"Delegation is explicit."}\n',
    encoding="utf-8",
  )
  candidate = (
    json.dumps(
      {
        "governance": {
          "annotation_evidence": {
            "disagreement_ids": report["agreement"]["disagreement_ids"],
            "raw_agreement": report["agreement"]["raw_agreement"],
            "cohen_kappa": report["agreement"]["cohen_kappa"],
            "pool_sha256": files["pool"]["sha256"],
            "annotator_a_sha256": files["annotator_a"]["sha256"],
            "annotator_b_sha256": files["annotator_b"]["sha256"],
          }
        }
      },
      sort_keys=True,
    ) + "\n"
  ).encode()

  manifest = build_evidence_manifest(
    report,
    agreement_path=agreement_path,
    adjudication_path=adjudication_path,
    adjudicator_id="human-adjudicator",
    adjudicated_at="2026-08-17T10:00:00Z",
    candidate_name="candidate.json",
    candidate_bytes=candidate,
  )

  assert manifest["schema_version"] == "annotation-evidence/v1"
  assert manifest["candidate"] == {"name": "candidate.json", "sha256": digest(candidate)}
  assert set(manifest["files"]) == {
    "pool", "guide", "coverage_manifest", "annotator_a", "annotator_b",
    "agreement_report", "adjudication",
  }
  assert manifest["adjudicator"]["pseudonym"] == "human-adjudicator"
  assert "path" not in json.dumps(manifest)

  with pytest.raises(ValueError, match="after the frozen agreement measurement"):
    build_evidence_manifest(
      report,
      agreement_path=agreement_path,
      adjudication_path=adjudication_path,
      adjudicator_id="human-adjudicator",
      adjudicated_at="2026-08-17T07:00:00Z",
      candidate_name="candidate.json",
      candidate_bytes=candidate,
    )

  manifest_path = tmp_path / "manifest.json"
  manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
  assert validate_evidence_manifest(manifest_path, candidate) == manifest

  with pytest.raises(ValueError, match="candidate digest"):
    validate_evidence_manifest(manifest_path, candidate + b"tampered")

  bypass = json.loads(json.dumps(manifest))
  bypass["adjudicator"] = {"required": False, "decision_count": 0}
  del bypass["files"]["adjudication"]
  manifest_path.write_text(json.dumps(bypass), encoding="utf-8")
  with pytest.raises(ValueError, match="disagreement evidence"):
    validate_evidence_manifest(manifest_path, candidate)

  manifest = json.loads(json.dumps(manifest))
  del manifest["files"]["guide"]
  manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
  with pytest.raises(ValueError, match="file roles"):
    validate_evidence_manifest(manifest_path, candidate)


def test_private_annotation_cli_round_trip_binds_measure_finalize_and_freeze(tmp_path: Path):
  private = tmp_path / "private"
  private.mkdir()
  pool = [
    {
      "id": f"{language}-{quadrant}-{index:02d}",
      "language": language,
      "task": f"{language} independent task {quadrant} {index}",
      "context": f"Independent context {language} {quadrant} {index}",
    }
    for language in ("en", "pl")
    for quadrant in range(4)
    for index in range(30)
  ]
  labels = {row["id"]: int(row["id"].split("-")[1]) for row in pool}
  labels_b = dict(labels)
  labels_b["en-0-00"] = 1

  def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")

  pool_path = private / "pool.jsonl"
  coverage_path = private / "internal-strata.jsonl"
  annotator_a_path = private / "annotator-a.jsonl"
  annotator_b_path = private / "annotator-b.jsonl"
  guide_path = private / "guide.md"
  write_jsonl(pool_path, pool)
  write_jsonl(coverage_path, [{"id": row["id"]} for row in pool])
  write_jsonl(annotator_a_path, [{"id": key, "quadrant": value} for key, value in labels.items()])
  write_jsonl(annotator_b_path, [{"id": key, "quadrant": value} for key, value in labels_b.items()])
  guide_path.write_text("human-only guide\n", encoding="utf-8")
  agreement_path = private / "agreement.json"

  measure = subprocess.run(
    [
      sys.executable, str(PROJECT_ROOT / "scripts/measure_annotation_agreement.py"),
      "--pool", str(pool_path), "--guide", str(guide_path),
      "--coverage-manifest", str(coverage_path),
      "--annotator-a", str(annotator_a_path), "--annotator-b", str(annotator_b_path),
      "--annotator-a-id", "human-a", "--annotator-a-completed-at", "2026-08-17T08:00:00Z",
      "--annotator-b-id", "human-b", "--annotator-b-completed-at", "2026-08-17T09:00:00Z",
      "--measured-at", "2026-08-17T09:05:00Z",
      "--packet-version", "production-v1", "--output", str(agreement_path),
    ],
    check=False,
    capture_output=True,
    text=True,
  )
  assert measure.returncode == 0, measure.stderr
  frozen_agreement_bytes = agreement_path.read_bytes()
  rerun = subprocess.run(measure.args, check=False, capture_output=True, text=True)
  assert rerun.returncode == 2
  assert agreement_path.read_bytes() == frozen_agreement_bytes

  adjudication_path = private / "adjudication.jsonl"
  write_jsonl(
    adjudication_path,
    [{"id": "en-0-00", "quadrant": 0, "rationale": "The owner must act now."}],
  )
  candidate_path = private / "candidate.json"
  evidence_path = private / "evidence.json"
  finalize = subprocess.run(
    [
      sys.executable, str(PROJECT_ROOT / "scripts/finalize_annotations.py"),
      "--agreement-report", str(agreement_path), "--pool", str(pool_path),
      "--guide", str(guide_path), "--coverage-manifest", str(coverage_path),
      "--annotator-a", str(annotator_a_path), "--annotator-b", str(annotator_b_path),
      "--adjudication", str(adjudication_path), "--adjudicator-id", "human-adjudicator",
      "--adjudicated-at", "2026-08-17T10:00:00Z", "--dataset-name", "production-v1",
      "--candidate-output", str(candidate_path), "--manifest-output", str(evidence_path),
    ],
    check=False,
    capture_output=True,
    text=True,
  )
  assert finalize.returncode == 0, finalize.stderr

  frozen_path = private / "frozen.json"
  release_path = private / "release.json"
  freeze = subprocess.run(
    [
      sys.executable, str(PROJECT_ROOT / "scripts/freeze_evaluation.py"),
      "--input", str(candidate_path), "--evidence-manifest", str(evidence_path),
      "--output", str(frozen_path), "--manifest", str(release_path),
      "--approver-id", "human-approver", "--approved-at", "2026-08-17T11:00:00Z",
    ],
    check=False,
    capture_output=True,
    text=True,
  )
  assert freeze.returncode == 0, freeze.stderr
  frozen = json.loads(frozen_path.read_text(encoding="utf-8"))
  assert frozen["governance"]["annotation_evidence"]["evidence_manifest_sha256"] == digest(
    evidence_path.read_bytes()
  )
  assert agreement_path.stat().st_mode & 0o777 == 0o600
  assert candidate_path.stat().st_mode & 0o777 == 0o600
  assert private.stat().st_mode & 0o777 == 0o700
