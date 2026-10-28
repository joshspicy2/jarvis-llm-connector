"""End-to-end test: real MCP client -> connector over HTTP -> mocked Gemini/OpenAI."""

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

ROOT = Path(__file__).resolve().parents[1]
SECRET = "s3cret-path-token-for-tests-0123456789"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_up(url: str) -> None:
    for _ in range(100):
        try:
            httpx.get(url, timeout=0.5)
            return
        except httpx.HTTPError:
            time.sleep(0.1)
    raise RuntimeError(f"{url} never came up")


@pytest.fixture(scope="module")
def servers():
    mock_port, srv_port = free_port(), free_port()
    mock = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "tests.mock_upstream:app", "--port", str(mock_port), "--log-level", "warning"],
        cwd=ROOT,
    )
    env = dict(
        os.environ,
        PORT=str(srv_port),
        CONNECTOR_SECRET=SECRET,
        GEMINI_API_KEY="test-gemini-key",
        OPENAI_API_KEY="test-openai-key",
        GEMINI_BASE_URL=f"http://127.0.0.1:{mock_port}/v1beta",
        OPENAI_BASE_URL=f"http://127.0.0.1:{mock_port}/v1",
        OPENAI_MODEL="gpt-test",
        ALLOWED_HOSTS=f"127.0.0.1:{srv_port}",
    )
    srv = subprocess.Popen([sys.executable, "server.py"], cwd=ROOT, env=env)
    try:
        wait_up(f"http://127.0.0.1:{mock_port}/_received")
        wait_up(f"http://127.0.0.1:{srv_port}/health")
        yield f"http://127.0.0.1:{srv_port}", f"http://127.0.0.1:{mock_port}"
    finally:
        for p in (srv, mock):
            p.terminate()
            p.wait(5)


async def call(base: str, tool: str, args: dict):
    async with streamable_http_client(f"{base}/{SECRET}/mcp") as (read, write, *_):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = {t.name for t in (await session.list_tools()).tools}
            assert tools == {"gemini_research", "chatgpt_ask", "second_opinion"}
            result = await session.call_tool(tool, args)
            return "".join(c.text for c in result.content if c.type == "text")


@pytest.mark.anyio
async def test_gemini_research(servers):
    base, mock = servers
    text = await call(base, "gemini_research", {"prompt": "carpet cleaning prices in Gainesville FL"})
    assert "Gemini says: researched 'carpet cleaning prices in Gainesville FL'" in text
    assert text.count("https://example.com/a") == 1  # duplicate sources collapsed
    req = [r for r in httpx.get(f"{mock}/_received").json() if r["api"] == "gemini"][-1]
    assert req["path"].endswith("/models/gemini-2.5-pro:generateContent")
    assert req["body"]["tools"] == [{"google_search": {}}]


@pytest.mark.anyio
async def test_chatgpt_ask_default_and_override_model(servers):
    base, mock = servers
    assert "ChatGPT (gpt-test) says: fix my python" in await call(base, "chatgpt_ask", {"prompt": "fix my python"})
    assert "ChatGPT (o-custom)" in await call(base, "chatgpt_ask", {"prompt": "hi", "model": "o-custom"})


@pytest.mark.anyio
async def test_second_opinion_sends_review_instructions(servers):
    base, mock = servers
    await call(base, "second_opinion", {"report": "Deep clean costs $50.", "focus": "pricing"})
    req = [r for r in httpx.get(f"{mock}/_received").json() if r["api"] == "openai"][-1]
    assert "reviewing a report" in req["body"]["instructions"]
    assert req["body"]["input"].startswith("Focus especially on: pricing")


def test_wrong_or_missing_secret_is_404(servers):
    base, _ = servers
    assert httpx.post(f"{base}/mcp", json={}).status_code == 404
    assert httpx.post(f"{base}/wrong-secret/mcp", json={}).status_code == 404
    assert httpx.get(f"{base}/health").text == "ok"


@pytest.fixture
def anyio_backend():
    return "asyncio"
