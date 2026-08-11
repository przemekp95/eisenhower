import json
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.error import HTTPError
from unittest.mock import Mock, patch

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


class _RedirectState:
    def __init__(self, status: int | None = None) -> None:
        self.status = status
        self.location = ""
        self.requests: list[dict[str, str | None]] = []


def _redirect_handler(state: _RedirectState):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: object) -> None:
            return

        def do_GET(self) -> None:
            state.requests.append(
                {
                    "path": self.path,
                    "authorization": self.headers.get("Authorization"),
                }
            )
            if state.status is not None and self.path == "/tasks":
                self.send_response(state.status)
                self.send_header("Location", state.location)
                self.end_headers()
                return

            payload = b"[]"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return Handler


class _RunningRedirectServer:
    def __init__(self, status: int | None = None) -> None:
        self.state = _RedirectState(status)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _redirect_handler(self.state))
        self.thread = Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self.httpd.server_address
        return f"http://{host}:{port}"

    def __enter__(self) -> "_RunningRedirectServer":
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)


class EisenhowerApiClientTest(unittest.TestCase):
    @patch("eisenhower_mcp.http_client.urlopen")
    def test_sends_bearer_without_client_controlled_tenant_headers_or_query_secrets(self, mocked_open) -> None:
        mocked_open.return_value = FakeResponse(200, [])
        client = EisenhowerApiClient(
            "https://api.example.test",
            "https://ai.example.test",
            bearer_token="secret-token",
        )

        client.list_tasks()

        request = mocked_open.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.example.test/tasks")
        self.assertEqual(request.headers["Authorization"], "Bearer secret-token")
        self.assertNotIn("X-tenant-id", request.headers)

    def test_rejects_non_https_remote_api(self) -> None:
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            EisenhowerApiClient("http://api.example.test", "https://ai.example.test")

        with self.assertRaisesRegex(ValueError, "HTTPS"):
            EisenhowerApiClient("https://api.example.test", "http://ai.example.test")

    def test_allows_loopback_http_for_local_development(self) -> None:
        client = EisenhowerApiClient("http://127.0.0.1:3001", "http://127.0.0.1:8000")
        self.assertEqual(client.task_base_url, "http://127.0.0.1:3001")
        self.assertEqual(client.ai_base_url, "http://127.0.0.1:8000")

    @patch("eisenhower_mcp.http_client.urlopen")
    def test_routes_task_and_knowledge_requests_to_separate_upstreams(self, mocked_open) -> None:
        mocked_open.side_effect = [FakeResponse(200, []), FakeResponse(200, {"citations": []})]
        client = EisenhowerApiClient(
            "http://127.0.0.1:3001",
            "http://127.0.0.1:8000",
        )

        client.list_tasks()
        client.search_knowledge("governed RAG", None, 5)

        self.assertEqual(mocked_open.call_args_list[0].args[0].full_url, "http://127.0.0.1:3001/tasks")
        self.assertEqual(
            mocked_open.call_args_list[1].args[0].full_url,
            "http://127.0.0.1:8000/v2/knowledge/search",
        )

    @patch("eisenhower_mcp.http_client.urlopen")
    def test_rejects_oversized_response(self, mocked_open) -> None:
        mocked_open.return_value = FakeResponse(200, {"payload": "x" * 100})
        client = EisenhowerApiClient(
            "https://api.example.test",
            "https://ai.example.test",
            max_response_bytes=20,
        )

        with self.assertRaises(ApiClientError):
            client.list_tasks()

    @patch("eisenhower_mcp.http_client.urlopen")
    def test_closes_http_error_response_before_sanitizing_it(self, mocked_open) -> None:
        error = HTTPError(
            "https://api.example.test/tasks",
            403,
            "private upstream detail",
            hdrs=None,
            fp=None,
        )
        error.close = Mock(wraps=error.close)
        mocked_open.side_effect = error
        client = EisenhowerApiClient(
            "https://api.example.test",
            "https://ai.example.test",
        )

        with self.assertRaisesRegex(ApiClientError, "HTTP 403"):
            client.list_tasks()

        error.close.assert_called_once_with()

    def test_rejects_same_origin_redirects_without_replaying_authorization(self) -> None:
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status), _RunningRedirectServer(status) as upstream:
                upstream.state.location = f"{upstream.url}/redirected"
                client = EisenhowerApiClient(
                    upstream.url,
                    upstream.url,
                    bearer_token="secret-token",
                )

                with self.assertRaisesRegex(ApiClientError, f"HTTP {status}"):
                    client.list_tasks()

                self.assertEqual(
                    upstream.state.requests,
                    [{"path": "/tasks", "authorization": "Bearer secret-token"}],
                )

    def test_rejects_cross_origin_redirects_without_forwarding_authorization(self) -> None:
        for status in (301, 302, 303, 307, 308):
            with (
                self.subTest(status=status),
                _RunningRedirectServer() as destination,
                _RunningRedirectServer(status) as source,
            ):
                source.state.location = f"{destination.url}/redirected"
                client = EisenhowerApiClient(
                    source.url,
                    source.url,
                    bearer_token="secret-token",
                )

                with self.assertRaisesRegex(ApiClientError, f"HTTP {status}"):
                    client.list_tasks()

                self.assertEqual(
                    source.state.requests,
                    [{"path": "/tasks", "authorization": "Bearer secret-token"}],
                )
                self.assertEqual(destination.state.requests, [])


if __name__ == "__main__":
    unittest.main()
