import pytest

from app.auth import AuthError, OIDCVerifier, StaticTokenVerifier


def test_static_token_verifier_uses_constant_server_side_identity_mapping():
  verifier = StaticTokenVerifier(user_token="user-token", admin_token="admin-token")

  user = verifier.verify("user-token")
  admin = verifier.verify("admin-token")

  assert user.tenant_id == "local"
  assert user.user_id == "local-user"
  assert user.roles == ["user"]
  assert admin.roles == ["operator", "admin"]
  assert admin.scopes == [
    "ai:operate",
    "ai:analyze",
    "knowledge:read",
    "memory:read",
    "memory:write",
  ]
  assert user.scopes == ["ai:analyze", "memory:read", "memory:write"]


def test_static_token_verifier_rejects_unknown_tokens():
  verifier = StaticTokenVerifier(user_token="user-token", admin_token="admin-token")

  with pytest.raises(AuthError):
    verifier.verify("unknown")


def test_oidc_verifier_requires_https_issuer_and_audience():
  with pytest.raises(ValueError):
    OIDCVerifier(issuer="http://identity.example.com", audience="api")

  with pytest.raises(ValueError):
    OIDCVerifier(issuer="https://identity.example.com", audience="")
