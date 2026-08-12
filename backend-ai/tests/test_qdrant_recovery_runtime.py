import os

import pytest

from scripts.verify_qdrant_recovery import run_verification


pytestmark = pytest.mark.skipif(
  os.getenv("RUN_LIVE_QDRANT_RECOVERY") != "1",
  reason="requires explicitly enabled local Qdrant snapshot and alias mutations",
)


def test_real_qdrant_snapshot_restore_isolation_cutover_and_rollback():
  report = run_verification()

  assert report["qdrant_server"]["version"] == "1.12.0"
  assert report["snapshot"]["qdrant_checksum"] == (
    report["snapshot"]["independent_download_sha256"]
  )
  assert report["restore"]["matches_source"] is True
  assert report["isolation"] == {
    "allowed_scope_hits": ["allowed", "delete-me"],
    "wrong_project_hits": [],
    "wrong_user_hits": [],
    "cross_tenant_hits": [],
  }
  assert report["physical_removal"] == {
    "stale_chunk_absent": True,
    "tombstoned_chunk_absent_from_source": True,
    "tombstoned_chunk_absent_from_restored": True,
    "orphan_points": [],
  }
  assert report["alias"]["previous_collection_retained"] is True
  assert report["alias"]["rollback_hits"] == ["allowed"]
  assert all(report["cleanup"].values())
  assert report["production_recovery_proven"] is False
