from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


def test_prometheus_scrapes_the_real_private_inference_service():
  config = yaml.safe_load((ROOT / "monitoring" / "prometheus.yml").read_text())
  jobs = {item["job_name"]: item for item in config["scrape_configs"]}

  assert jobs["prometheus"]["static_configs"] == [{"targets": ["localhost:9090"]}]
  assert jobs["prometheus"]["metrics_path"] == "/admin/prometheus/metrics"
  assert jobs["eisenhower-ai"]["static_configs"] == [{"targets": ["ai-service:8000"]}]
  assert jobs["inference"]["static_configs"] == [{"targets": ["inference:8000"]}]
  assert config["rule_files"] == ["alert_rules.yml"]


def test_alerts_use_real_inference_job_and_cover_worker_heartbeat():
  config = yaml.safe_load((ROOT / "monitoring" / "alert_rules.yml").read_text())
  rules = {rule["alert"]: rule for group in config["groups"] for rule in group["rules"]}

  assert 'job="inference"' in rules["PrivateInferenceUnavailable"]["expr"]
  assert 'state!="disabled"' in rules["PrivateInferenceUnavailable"]["expr"]
  assert "VllmUnavailable" not in rules
  assert "eisenhower_job_worker_heartbeat_age_seconds" in rules["EisenhowerRagWorkerStale"]["expr"]
  assert "eisenhower_job_queue_enabled == 1" in rules["EisenhowerRagWorkerStale"]["expr"]
  assert "> 90" in rules["EisenhowerRagWorkerStale"]["expr"]
  assert 'outcome="error"' in rules["EisenhowerAuditWriteFailed"]["expr"]


def test_public_ci_upload_excludes_private_ai_registry_manifests_and_snapshots():
  workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
  upload = workflow.split("- name: Upload non-sensitive AI candidate commitments", 1)[1].split(
    "\n  test-mobile:", 1
  )[0]
  assert "commitment.json" in upload
  assert "eisenhower-ai-registry" not in upload
  assert "manifest.json" not in upload
  assert "qdrant-candidate.snapshot" not in upload
