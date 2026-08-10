import json
import unittest
from unittest.mock import patch

from eisenhower_mcp.http_client import ApiClientError, EisenhowerApiClient


class FakeResponse:
    def __init__(self, status: int, payload: object) -> None:
        self.status = status
        self._payload = json.dumps(payload).encode("utf-8")

    def read(self, _limit: int = -1) -> bytes:
        return self._payload

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None


class EisenhowerApiClientTest(unittest.TestCase):
    @patch("eisenhower_mcp.http_client.urlopen")
    def test_sends_bearer_without_client_controlled_tenant_headers_or_query_secrets(self, mocked_open) -> None:
        mocked_open.return_value = FakeResponse(200, [])
        client = EisenhowerApiClient(
            "https://api.example.test",
            bearer_token="secret-token",
        )

        client.list_tasks()

        request = mocked_open.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.example.test/tasks")
        self.assertEqual(request.headers["Authorization"], "Bearer secret-token")
        self.assertNotIn("X-tenant-id", request.headers)

    def test_rejects_non_https_remote_api(self) -> None:
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            EisenhowerApiClient("http://api.example.test")

    def test_allows_loopback_http_for_local_development(self) -> None:
        client = EisenhowerApiClient("http://127.0.0.1:3000")
        self.assertEqual(client.base_url, "http://127.0.0.1:3000")

    @patch("eisenhower_mcp.http_client.urlopen")
    def test_rejects_oversized_response(self, mocked_open) -> None:
        mocked_open.return_value = FakeResponse(200, {"payload": "x" * 100})
        client = EisenhowerApiClient("https://api.example.test", max_response_bytes=20)

        with self.assertRaises(ApiClientError):
            client.list_tasks()


if __name__ == "__main__":
    unittest.main()
