from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_operator_docs_make_admin_stack_mandatory_and_role_gated():
  readme = (ROOT / "README.md").read_text(encoding="utf-8")
  acceptance = (ROOT / "docs" / "PRODUCTION_ACCEPTANCE.md").read_text(encoding="utf-8")
  deploy = (ROOT / "deploy" / "generic" / "README.md").read_text(encoding="utf-8")
  docs = "\n".join((readme, acceptance, deploy))

  assert "optional private automation profile" not in docs
  assert "--profile n8n" not in docs
  for service in ("n8n", "Prometheus", "Grafana"):
    assert f"{service} is mandatory" in docs
  for route in ("/admin/n8n/", "/admin/prometheus/", "/admin/grafana/"):
    assert route in docs
  assert "eisenhower-admin" in docs


def test_acceptance_docs_preserve_public_webhook_and_state_boundaries():
  acceptance = (ROOT / "docs" / "PRODUCTION_ACCEPTANCE.md").read_text(encoding="utf-8")

  assert "/eisenhower/google-calendar/webhook" in acceptance
  assert "Grafana" in acceptance and "backup" in acceptance.lower()
  assert "Prometheus" in acceptance and "rebuild" in acceptance.lower()
  assert "live Keycloak" in acceptance
