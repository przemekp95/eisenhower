from pathlib import Path


ROOT = Path(__file__).parents[2]


def test_source_promotion_cannot_implicitly_release_or_deploy():
  workflow = ROOT.joinpath(".github/workflows/release.yml").read_text(encoding="utf-8")

  assert "workflow_run:" not in workflow
  assert "workflow_dispatch:" in workflow
  assert "release_sha:" in workflow
  assert "deploy:" in workflow
  assert "default: false" in workflow
  assert "github.event.inputs.deploy == 'true'" in workflow
  assert "IMAGE_TAG: ${{ inputs.release_sha }}" in workflow


def test_release_builds_each_ai_role_from_the_role_specific_target():
  workflow = ROOT.joinpath(".github/workflows/release.yml").read_text(encoding="utf-8")

  for target in ("boundary", "classifier", "knowledge", "ingest"):
    assert f"target: {target}" in workflow
  assert "target: knowledge-production" not in workflow
  assert "target: api-boundary" not in workflow
