from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


def test_prometheus_scrapes_the_real_private_inference_service():
  config = yaml.safe_load((ROOT / "monitoring" / "prometheus.yml").read_text())
  jobs = {item["job_name"]: item for item in config["scrape_configs"]}

  assert jobs["inference"]["static_configs"] == [{"targets": ["inference:8000"]}]


def test_alerts_use_real_inference_job_and_cover_worker_heartbeat():
  config = yaml.safe_load((ROOT / "monitoring" / "alert_rules.yml").read_text())
  rules = {rule["alert"]: rule for group in config["groups"] for rule in group["rules"]}

  assert 'job="inference"' in rules["PrivateInferenceUnavailable"]["expr"]
  assert 'state!="disabled"' in rules["PrivateInferenceUnavailable"]["expr"]
  assert "VllmUnavailable" not in rules
  assert "eisenhower_job_worker_heartbeat_age_seconds" in rules["EisenhowerRagWorkerStale"]["expr"]
  assert "eisenhower_job_queue_enabled == 1" in rules["EisenhowerRagWorkerStale"]["expr"]
  assert "> 90" in rules["EisenhowerRagWorkerStale"]["expr"]
