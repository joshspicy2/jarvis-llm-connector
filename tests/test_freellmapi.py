"""FreeLLMAPI opt-in tool: no network (respx)."""

import httpx
import pytest
import respx

import server


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(server, "FREELLMAPI_BASE_URL", "http://127.0.0.1:3001/v1")
    monkeypatch.setenv("FREELLMAPI_API_KEY", "freellmapi-k")


def test_off_by_default(monkeypatch):
    monkeypatch.setattr(server, "FREELLMAPI_BASE_URL", "")
    monkeypatch.delenv("FREELLMAPI_API_KEY", raising=False)
    assert not server.freellmapi_enabled()


@pytest.mark.anyio
@respx.mock
async def test_ok_and_routed_via(enabled):
    route = respx.post("http://127.0.0.1:3001/v1/chat/completions").mock(
        return_value=httpx.Response(
            200, json={"choices": [{"message": {"content": "hello"}}]}, headers={"x-routed-via": "groq/x"}
        )
    )
    out = await server.call_freellmapi("hi", "auto", "be brief")
    assert out.startswith("hello") and "groq/x" in out
    req = route.calls[0].request
    assert req.headers["authorization"] == "Bearer freellmapi-k"
    assert b'"role":"system"' in req.content.replace(b" ", b"")


@pytest.mark.anyio
@respx.mock
async def test_http_error_and_empty(enabled):
    respx.post("http://127.0.0.1:3001/v1/chat/completions").mock(
        side_effect=[httpx.Response(429, json={"error": "limits"}), httpx.Response(200, json={"choices": []})]
    )
    with pytest.raises(server.UpstreamError, match="HTTP 429"):
        await server.call_freellmapi("hi", "auto", None)
    with pytest.raises(server.UpstreamError, match="no answer"):
        await server.call_freellmapi("hi", "auto", None)


@pytest.mark.anyio
async def test_plain_http_to_remote_host_refused(monkeypatch):
    monkeypatch.setattr(server, "FREELLMAPI_BASE_URL", "http://10.0.0.5:3001/v1")
    monkeypatch.setenv("FREELLMAPI_API_KEY", "k")
    with pytest.raises(server.UpstreamError, match="https"):
        await server.call_freellmapi("hi", "auto", None)
