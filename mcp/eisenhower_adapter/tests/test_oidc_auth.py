import base64
import json
import time
import unittest
from unittest.mock import Mock, patch

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from mcp.server.auth.middleware.auth_context import auth_context_var
from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser
from mcp.server.auth.provider import AccessToken
from starlette.testclient import TestClient

from eisenhower_mcp.oidc import KeycloakJwtVerifier
from eisenhower_mcp.token_exchange import KeycloakTokenExchange
from eisenhower_mcp import server


def _b64uint(value: int) -> str:
    size = (value.bit_length() + 7) // 8
    return base64.urlsafe_b64encode(value.to_bytes(size, "big")).rstrip(b"=").decode()


class OidcResourceServerTest(unittest.IsolatedAsyncioTestCase):
    async def test_verifies_rs256_issuer_audience_expiry_and_identity_claims(self) -> None:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public = private_key.public_key().public_numbers()
        jwks = {
            "keys": [{
                "kty": "RSA", "kid": "key-1", "use": "sig", "alg": "RS256",
                "n": _b64uint(public.n), "e": _b64uint(public.e),
            }]
        }
        now = int(time.time())
        token = jwt.encode(
            {
                "iss": "https://id.example.test/realms/eisenhower",
                "aud": "eisenhower-mcp",
                "sub": "user-a",
                "tenant_id": "tenant-a",
                "azp": "mcp-client",
                "scope": "mcp:tools tasks:read",
                "iat": now,
                "exp": now + 300,
            },
            private_key,
            algorithm="RS256",
            headers={"kid": "key-1"},
        )
        verifier = KeycloakJwtVerifier(
            issuer="https://id.example.test/realms/eisenhower",
            audience="eisenhower-mcp",
            jwks_url="https://id.example.test/realms/eisenhower/protocol/openid-connect/certs",
            fetch_json=Mock(return_value=jwks),
        )

        verified = await verifier.verify_token(token)

        self.assertIsNotNone(verified)
        self.assertEqual(verified.token, token)
        self.assertEqual(verified.subject, "user-a")
        self.assertEqual(verified.claims["tenant_id"], "tenant-a")
        self.assertIn("tasks:read", verified.scopes)

    async def test_fails_closed_for_wrong_audience_missing_tenant_and_unknown_key(self) -> None:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        now = int(time.time())
        verifier = KeycloakJwtVerifier(
            issuer="https://id.example.test/realms/eisenhower",
            audience="eisenhower-mcp",
            jwks_url="https://id.example.test/certs",
            fetch_json=Mock(return_value={"keys": []}),
        )
        token = jwt.encode(
            {"iss": "https://id.example.test/realms/eisenhower", "aud": "other",
             "sub": "user-a", "scope": "mcp:tools", "exp": now + 300},
            private_key, algorithm="RS256", headers={"kid": "missing"},
        )

        self.assertIsNone(await verifier.verify_token(token))


class KeycloakTokenExchangeTest(unittest.TestCase):
    @patch("eisenhower_mcp.token_exchange.urlopen")
    def test_exchanges_subject_token_without_passing_it_to_upstream_api(self, mocked_open) -> None:
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=None)
        response.read.return_value = json.dumps(
            {"access_token": "upstream-api-token", "expires_in": 120, "token_type": "Bearer"}
        ).encode()
        mocked_open.return_value = response
        exchange = KeycloakTokenExchange(
            token_endpoint="https://id.example.test/realms/eisenhower/protocol/openid-connect/token",
            client_id="eisenhower-mcp",
            client_secret="client-secret",
            audience="eisenhower-api",
        )
        incoming = AccessToken(
            token="incoming-mcp-token",
            client_id="desktop-client",
            scopes=["mcp:tools", "tasks:read"],
            subject="user-a",
            claims={"tenant_id": "tenant-a", "iss": "https://id.example.test/realms/eisenhower"},
        )

        exchanged = exchange.exchange(incoming)

        self.assertEqual(exchanged, "upstream-api-token")
        request = mocked_open.call_args.args[0]
        form = request.data.decode()
        self.assertIn("subject_token=incoming-mcp-token", form)
        self.assertIn("audience=eisenhower-api", form)
        self.assertIn("scope=tasks%3Aread", form)
        self.assertNotIn("mcp%3Atools", form)
        self.assertNotIn("client-secret", form)

    @patch("eisenhower_mcp.token_exchange.urlopen")
    def test_cache_is_isolated_by_subject_token(self, mocked_open) -> None:
        responses = []
        for value in ("api-token-a", "api-token-b"):
            response = Mock()
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=None)
            response.read.return_value = json.dumps(
                {"access_token": value, "expires_in": 120, "token_type": "Bearer"}
            ).encode()
            responses.append(response)
        mocked_open.side_effect = responses
        exchange = KeycloakTokenExchange(
            token_endpoint="https://id.example.test/token",
            client_id="eisenhower-mcp",
            client_secret="client-secret",
            audience="eisenhower-api",
        )
        base = dict(client_id="desktop", scopes=["tasks:read"], subject="user",
                    claims={"tenant_id": "tenant"})

        self.assertEqual(exchange.exchange(AccessToken(token="mcp-a", **base)), "api-token-a")
        self.assertEqual(exchange.exchange(AccessToken(token="mcp-b", **base)), "api-token-b")
        self.assertEqual(exchange.exchange(AccessToken(token="mcp-a", **base)), "api-token-a")
        self.assertEqual(mocked_open.call_count, 2)


class RemoteToolIsolationTest(unittest.TestCase):
    def test_per_tool_scope_and_dynamic_audit_identity_are_enforced(self) -> None:
        incoming = AccessToken(
            token="incoming-mcp-token",
            client_id="desktop",
            scopes=["mcp:tools", "tasks:read"],
            subject="user-a",
            claims={"tenant_id": "tenant-a", "iss": "https://id.example.test/realms/eisenhower"},
        )
        recorder = Mock()
        old_audit = server.audit_recorder
        server.audit_recorder = recorder
        context = auth_context_var.set(AuthenticatedUser(incoming))
        try:
            result = server._invoke_tool("matrix_summary", lambda: {"ok": True})
            with self.assertRaisesRegex(PermissionError, "scope"):
                server._invoke_tool("task_create", lambda: {"should_not_run": True})
        finally:
            auth_context_var.reset(context)
            server.audit_recorder = old_audit

        self.assertEqual(result, {"ok": True})
        recorder.record_tool.assert_any_call(
            "matrix_summary", "attempt", "accepted", unittest.mock.ANY,
            tenant_id="tenant-a", actor_id="user-a",
        )

    def test_current_mcp_token_is_exchanged_and_never_configured_as_upstream_bearer(self) -> None:
        incoming = AccessToken(
            token="incoming-mcp-token",
            client_id="desktop",
            scopes=["mcp:tools", "tasks:read"],
            subject="user-a",
            claims={"tenant_id": "tenant-a"},
        )
        exchanger = Mock()
        exchanger.exchange.return_value = "exchanged-api-token"
        factory = Mock(return_value=object())
        old_exchange = server.token_exchange
        old_service = server.service
        server.token_exchange = exchanger
        server.service = None
        context = auth_context_var.set(AuthenticatedUser(incoming))
        try:
            with patch.object(server, "_service_from_environment", factory):
                configured = server._service()
        finally:
            auth_context_var.reset(context)
            server.token_exchange = old_exchange
            server.service = old_service

        self.assertIs(configured, factory.return_value)
        exchanger.exchange.assert_called_once_with(incoming)
        factory.assert_called_once_with(bearer_token="exchanged-api-token")
        self.assertNotIn("incoming-mcp-token", repr(factory.call_args))

    def test_remote_server_uses_sdk_auth_settings_and_protected_resource_metadata(self) -> None:
        env = {
            "MCP_OIDC_ISSUER": "https://id.example.test/realms/eisenhower",
            "MCP_OIDC_AUDIENCE": "eisenhower-mcp",
            "MCP_OIDC_JWKS_URL": "https://id.example.test/realms/eisenhower/protocol/openid-connect/certs",
            "MCP_RESOURCE_SERVER_URL": "https://mcp.example.test/mcp",
            "MCP_OIDC_TOKEN_ENDPOINT": "https://id.example.test/realms/eisenhower/protocol/openid-connect/token",
            "MCP_OIDC_CLIENT_ID": "eisenhower-mcp",
            "MCP_OIDC_CLIENT_SECRET": "secret",
            "EISENHOWER_API_AUDIENCE": "eisenhower-api",
        }
        with patch.dict("os.environ", env, clear=True):
            remote = server._remote_server_from_environment()

        self.assertEqual(str(remote.settings.auth.issuer_url), env["MCP_OIDC_ISSUER"])
        self.assertEqual(str(remote.settings.auth.resource_server_url), env["MCP_RESOURCE_SERVER_URL"])
        self.assertEqual(remote.settings.auth.required_scopes, ["mcp:tools"])
        self.assertIsInstance(remote._token_verifier, KeycloakJwtVerifier)

        app = remote.streamable_http_app(streamable_http_path="/mcp")
        with TestClient(app) as client:
            metadata = client.get("/.well-known/oauth-protected-resource/mcp")
        self.assertEqual(metadata.status_code, 200)
        self.assertEqual(metadata.json()["resource"], env["MCP_RESOURCE_SERVER_URL"])
        self.assertEqual(metadata.json()["authorization_servers"], [env["MCP_OIDC_ISSUER"]])
        self.assertEqual(metadata.json()["scopes_supported"], ["mcp:tools"])


if __name__ == "__main__":
    unittest.main()
