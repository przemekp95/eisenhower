from pathlib import Path


ROOT = Path(__file__).parents[2]


def test_source_promotion_cannot_implicitly_release_or_deploy():
  workflow = ROOT.joinpath(".github/workflows/release.yml").read_text(encoding="utf-8")
  deploy_workflow = ROOT.joinpath(".github/workflows/deploy.yml")

  assert "workflow_run:" not in workflow
  assert "workflow_dispatch:" in workflow
  assert "release_sha:" in workflow
  assert "force-new-deployment" not in workflow
  assert "AWS_" not in workflow
  assert "mikrus" not in workflow.lower()
  assert "deploy:" not in workflow
  assert deploy_workflow.is_file()


def test_release_has_one_aggregate_publication_gate_and_immutable_manifest():
  workflow = ROOT.joinpath(".github/workflows/release.yml").read_text(encoding="utf-8")

  build = workflow[workflow.index("  docker-build-scan:"):workflow.index("  publish-release:")]
  publish = workflow[workflow.index("  publish-release:"):]
  assert "docker push" not in build
  assert "push: false" in build
  assert "needs:\n      - docker-build-scan" in publish
  assert "release-manifest.json" in publish
  assert "RepoDigests" in publish
  assert "sha256sum" in publish
  assert "docker push" in publish


def test_generic_deploy_consumes_release_manifest_without_provider_specific_jobs():
  workflow = ROOT.joinpath(".github/workflows/deploy.yml").read_text(encoding="utf-8")

  assert "workflow_dispatch:" in workflow
  assert "release_run_id:" in workflow
  assert "release-manifest.json" in workflow
  assert "deploy-release" in workflow
  assert "aws" not in workflow.lower()
  assert "mikrus" not in workflow.lower()
  assert "force-new-deployment" not in workflow
  assert "enable_n8n" not in workflow
  assert "--profile n8n" not in workflow


def test_deploy_requires_every_image_published_in_the_release_manifest():
  release = ROOT.joinpath(".github/workflows/release.yml").read_text(encoding="utf-8")
  deploy = ROOT.joinpath(".github/workflows/deploy.yml").read_text(encoding="utf-8")

  assert "test \"$(jq '.images | length' \"$manifest\")\" -eq 8" in release
  assert "test \"$(jq '.images | length' release/release-manifest.json)\" -eq 8" in deploy


def test_final_release_gate_binds_container_and_android_artifacts():
  workflow = ROOT.joinpath(".github/workflows/release.yml").read_text(encoding="utf-8")
  final_gate = workflow[workflow.index("  final-release-gate:"):]

  assert "- publish-release" in final_gate
  assert "- android-release" in final_gate
  assert "final-release.json" in final_gate
  assert "release-manifest.json.sha256" in final_gate
  assert "android-release-" in final_gate


def test_release_secrets_are_gated_by_exact_green_master_preflight():
  workflow = ROOT.joinpath(".github/workflows/release.yml").read_text(encoding="utf-8")

  assert "release-preflight:" in workflow
  assert "run: node .github/scripts/release-preflight.mjs" in workflow
  assert "ref: master" in workflow
  assert "needs: release-preflight" in workflow
  assert "ref: ${{ needs.release-preflight.outputs.release_sha }}" in workflow
  assert "permissions:\n  contents: read" in workflow
  assert "timeout-minutes:" in workflow
  assert "concurrency:" in workflow


def test_release_builds_each_ai_role_from_the_role_specific_target():
  workflow = ROOT.joinpath(".github/workflows/release.yml").read_text(encoding="utf-8")

  for target in ("boundary", "classifier", "knowledge", "ingest"):
    assert f"target: {target}" in workflow
  assert "target: knowledge-production" not in workflow
  assert "target: api-boundary" not in workflow


def test_release_scans_and_publishes_the_exact_rocm_response_image():
  workflow = ROOT.joinpath(".github/workflows/release.yml").read_text(encoding="utf-8")

  assert "name: backend-ai-response-rocm" in workflow
  assert "dockerfile: ./backend-ai/Dockerfile.response-rocm" in workflow
  assert "tag: eisenhower-ai-response-rocm" in workflow
  assert "target: response" in workflow
  assert "backend-ai-response-rocm|eisenhower-ai-response-rocm" in workflow
  assert "test \"$(jq '.images | length' \"$manifest\")\" -eq 8" in workflow

  response_entry = workflow.index("          - name: backend-ai-response-rocm")
  next_entry = workflow.index("          - name:", response_entry + 12)
  response_matrix = workflow[response_entry:next_entry]
  assert "require_torch: false" in response_matrix
  assert "require_torchvision: false" in response_matrix
