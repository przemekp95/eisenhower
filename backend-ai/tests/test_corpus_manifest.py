import json
from hashlib import sha256
from pathlib import Path

import pytest

from app.rag.corpus_manifest import (
  CorpusManifest,
  ManifestViolation,
  RepositoryCorpusConnector,
  refresh_manifest_snapshot,
)
from app.rag.models import AccessScope


def write_manifest(root: Path, documents: list[str], snapshot: str):
  path = root / "manifest.json"
  path.write_text(json.dumps({
    "manifest_version": "test-v1",
    "initial_snapshot": {"algorithm": "sha256(sorted newline-separated sha256sum records)", "sha256": snapshot, "document_count": len(documents), "total_bytes": sum((root / item).stat().st_size for item in documents), "documents": documents},
    "document_policy": {"maximum_document_bytes": 1024, "maximum_documents": 10},
    "identity_and_acl": {
      "initial_tenant": "tenant-1",
      "cross_tenant_access": False,
      "request_payload_may_expand_scope": False,
    },
  }), encoding="utf-8")
  return path


def snapshot(root: Path, documents: list[str]) -> str:
  records = []
  for relative in sorted(documents):
    digest = sha256((root / relative).read_bytes()).hexdigest()
    records.append(f"{digest}  {relative}\n")
  return sha256("".join(records).encode()).hexdigest()


def test_connector_loads_only_frozen_allowlisted_files(tmp_path):
  (tmp_path / "docs").mkdir()
  (tmp_path / "docs" / "decision.md").write_text("# Decyzja\r\n\r\n  Treść  \n", encoding="utf-8")
  documents = ["docs/decision.md"]
  manifest = CorpusManifest.load(write_manifest(tmp_path, documents, snapshot(tmp_path, documents)))
  connector = RepositoryCorpusConnector(tmp_path, manifest)

  loaded = connector.load_initial(AccessScope(tenant_id="tenant-1", user_id="user-1", project_ids=["project-1"]))
  assert len(loaded) == 1
  assert loaded[0].source_uri == "eisenhower://repository/docs/decision.md"
  assert loaded[0].text == "# Decyzja\n\n  Treść"
  assert loaded[0].source_sequence == 1
  assert loaded[0].acl_subjects == ["tenant:tenant-1", "user:user-1", "project:project-1"]


def test_connector_rejects_snapshot_drift_traversal_and_symlink(tmp_path):
  (tmp_path / "safe.md").write_text("safe", encoding="utf-8")
  manifest = CorpusManifest.load(write_manifest(tmp_path, ["safe.md"], "0" * 64))
  with pytest.raises(ManifestViolation, match="snapshot"):
    RepositoryCorpusConnector(tmp_path, manifest).load_initial(AccessScope(tenant_id="t", user_id="u"))

  outside = tmp_path.parent / "outside.md"
  outside.write_text("outside", encoding="utf-8")
  (tmp_path / "link.md").symlink_to(outside)
  link_manifest = CorpusManifest.load(write_manifest(tmp_path, ["link.md"], snapshot(tmp_path, ["link.md"])))
  with pytest.raises(ManifestViolation, match="symlink"):
    RepositoryCorpusConnector(tmp_path, link_manifest).load_initial(AccessScope(tenant_id="t", user_id="u"))

  bad = write_manifest(tmp_path, ["../outside.md"], snapshot(tmp_path.parent, ["outside.md"]))
  with pytest.raises(ManifestViolation, match="relative"):
    RepositoryCorpusConnector(tmp_path, CorpusManifest.load(bad))


def test_connector_loads_allowlisted_incremental_markdown_with_caller_sequence(tmp_path):
  (tmp_path / "initial.md").write_text("initial", encoding="utf-8")
  (tmp_path / ".tasks").mkdir()
  (tmp_path / ".tasks" / "WORK_LOG.md").write_text("# Work log\n\nTASK-011", encoding="utf-8")
  manifest_path = write_manifest(tmp_path, ["initial.md"], snapshot(tmp_path, ["initial.md"]))
  manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
  manifest_data["incremental_sources"] = [{
    "root": ".tasks",
    "files": ["WORK_LOG.md"],
    "source_type": "task",
  }]
  manifest_path.write_text(json.dumps(manifest_data), encoding="utf-8")
  connector = RepositoryCorpusConnector(tmp_path, CorpusManifest.load(manifest_path))
  scope = AccessScope(tenant_id="tenant-1", user_id="user-1", project_ids=["project-1"])

  loaded = connector.load_incremental_markdown(scope, source_sequence=9)

  assert len(loaded) == 1
  assert loaded[0].source_uri == "eisenhower://repository/.tasks/WORK_LOG.md"
  assert loaded[0].source_type == "task"
  assert loaded[0].source_sequence == 9
  assert loaded[0].content_checksum == sha256(loaded[0].text.encode()).hexdigest()


def test_refresh_manifest_snapshot_binds_every_allowlisted_source_without_expanding_scope(tmp_path):
  (tmp_path / "a.md").write_text("alpha\n", encoding="utf-8")
  (tmp_path / "b.md").write_text("beta\n", encoding="utf-8")
  manifest_path = write_manifest(tmp_path, ["b.md", "a.md"], "0" * 64)

  refreshed = refresh_manifest_snapshot(tmp_path, manifest_path)

  snapshot_data = refreshed["initial_snapshot"]
  assert snapshot_data["documents"] == ["a.md", "b.md"]
  assert snapshot_data["document_count"] == 2
  assert snapshot_data["total_bytes"] == 11
  assert snapshot_data["sha256"] == snapshot(tmp_path, ["a.md", "b.md"])
  assert snapshot_data["records"] == [
    {
      "path": "a.md",
      "sha256": sha256(b"alpha\n").hexdigest(),
      "bytes": 6,
    },
    {
      "path": "b.md",
      "sha256": sha256(b"beta\n").hexdigest(),
      "bytes": 5,
    },
  ]


def test_connector_rejects_per_source_record_drift_even_if_aggregate_is_rewritten(tmp_path):
  (tmp_path / "safe.md").write_text("safe", encoding="utf-8")
  manifest_path = write_manifest(tmp_path, ["safe.md"], snapshot(tmp_path, ["safe.md"]))
  refreshed = refresh_manifest_snapshot(tmp_path, manifest_path)
  refreshed["initial_snapshot"]["records"][0]["sha256"] = "0" * 64
  manifest_path.write_text(json.dumps(refreshed), encoding="utf-8")

  connector = RepositoryCorpusConnector(tmp_path, CorpusManifest.load(manifest_path))
  with pytest.raises(ManifestViolation, match="source record"):
    connector.load_initial(AccessScope(tenant_id="t", user_id="u"))
