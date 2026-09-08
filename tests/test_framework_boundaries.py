from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_framework_boundary_verifier_is_green():
  completed = subprocess.run(
    ["node", "scripts/verify-framework-boundaries.mjs"],
    cwd=ROOT,
    check=False,
    capture_output=True,
    text=True,
  )

  assert completed.returncode == 0, completed.stderr


def test_runtime_factories_and_health_paths_remain_stable():
  node_dockerfile = (ROOT / "backend-node" / "Dockerfile").read_text(encoding="utf-8")
  ai_dockerfile = (ROOT / "backend-ai" / "Dockerfile").read_text(encoding="utf-8")
  compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")

  assert "3001/health/ready" in node_dockerfile
  assert '"main:app"' in ai_dockerfile
  assert "app.knowledge_runtime:from_environment" in ai_dockerfile
  assert "app.knowledge_runtime:from_environment" in compose


def test_node_route_inventory_has_one_final_owner_per_contract():
  contract = json.loads(
    (ROOT / "backend-node" / "contracts" / "node-http-routes.json").read_text(encoding="utf-8")
  )
  migration_map = (
    ROOT / "docs" / "architecture" / "node-http-migration-map.md"
  ).read_text(encoding="utf-8")

  assert len(contract) == 41
  assert migration_map.count("| nest-final |") == 41
