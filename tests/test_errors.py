"""Unit tests for error handling, with no network."""

import httpx
import pytest
import respx

import server


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_missing_key_is_reported(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert "OPENAI_API_KEY is not set" in await server.chatgpt_ask("hi")


@pytest.mark.anyio
@respx.mock
async def test_upstream_error_is_reported(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    respx.post(url__regex=r".*generateContent").mock(return_value=httpx.Response(429, json={"error": "quota"}))
    out = await server.gemini_research("q")
    assert "HTTP 429" in out and "quota" in out


@pytest.mark.anyio
@respx.mock
async def test_blocked_prompt(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    respx.post(url__regex=r".*generateContent").mock(
        return_value=httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}})
    )
    assert "SAFETY" in await server.gemini_research("q")


def test_short_secret_refused(monkeypatch):
    monkeypatch.setenv("CONNECTOR_SECRET", "short")
    with pytest.raises(SystemExit):
        server.build_app()
