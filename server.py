"""Jarvis LLM connector: a remote MCP server that lets Claude call Google Gemini (free tier).

Tools:
  gemini_research  - research a question with Gemini, grounded in Google Search
  gemini_ask       - ask Gemini anything without web search (coding help, quick answers)
  second_opinion   - have Gemini fact-check / critique a report Claude wrote
  free_llm_ask     - OPT-IN: ask a self-hosted FreeLLMAPI router (many free providers). Only
                     registered when FREELLMAPI_BASE_URL and FREELLMAPI_API_KEY are both set.

Configuration comes only from environment variables (see .env.example).
"""

from __future__ import annotations

import hmac
import logging
import os
from urllib.parse import urlparse

import httpx
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings


GEMINI_BASE_URL = os.environ.get("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
REQUEST_TIMEOUT = float(os.environ.get("REQUEST_TIMEOUT_SECONDS", "180"))
MAX_OUTPUT_TOKENS = int(os.environ.get("MAX_OUTPUT_TOKENS", "8000"))

FREELLMAPI_BASE_URL = os.environ.get("FREELLMAPI_BASE_URL", "").rstrip("/")
FREELLMAPI_MODEL = os.environ.get("FREELLMAPI_MODEL", "auto")
_LOOPBACK = {"127.0.0.1", "localhost", "::1"}

SECOND_OPINION_INSTRUCTIONS = (
    "You are reviewing a report written by another AI assistant (Claude). "
    "Check it for factual errors, faulty reasoning, bugs in any code, missing considerations, "
    "and claims that need a source. Be specific: quote the part you disagree with and say why. "
    "If the report is sound, say so briefly. End with a one-line verdict: "
    "AGREE, AGREE WITH CHANGES, or DISAGREE."
)


class UpstreamError(RuntimeError):
    pass


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise UpstreamError(f"{name} is not set on the connector server.")
    return value


async def _post_json(url: str, headers: dict[str, str], body: dict) -> dict:
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        resp = await client.post(url, headers=headers, json=body)
    if resp.status_code >= 400:
        # Upstream error bodies never contain our key, so they are safe to surface.
        raise UpstreamError(f"Upstream returned HTTP {resp.status_code}: {resp.text[:1000]}")
    return resp.json()


async def call_gemini(prompt: str, model: str, use_search: bool, system: str | None) -> str:
    key = _require_env("GEMINI_API_KEY")
    body: dict = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"maxOutputTokens": MAX_OUTPUT_TOKENS},
    }
    if use_search:
        body["tools"] = [{"google_search": {}}]
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}

    data = await _post_json(
        f"{GEMINI_BASE_URL}/models/{model}:generateContent",
        {"x-goog-api-key": key, "Content-Type": "application/json"},
        body,
    )

    candidates = data.get("candidates") or []
    if not candidates:
        reason = (data.get("promptFeedback") or {}).get("blockReason", "no candidates returned")
        raise UpstreamError(f"Gemini returned no answer ({reason}).")
    cand = candidates[0]
    text = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts", [])).strip()

    sources = []
    for chunk in (cand.get("groundingMetadata") or {}).get("groundingChunks", []):
        web = chunk.get("web") or {}
        if web.get("uri"):
            sources.append(f"- {web.get('title') or web['uri']}: {web['uri']}")
    if sources:
        text += "\n\nSources:\n" + "\n".join(dict.fromkeys(sources))
    return text or "(Gemini returned an empty answer.)"


def freellmapi_enabled() -> bool:
    return bool(FREELLMAPI_BASE_URL and os.environ.get("FREELLMAPI_API_KEY"))


def _check_freellmapi_url(url: str) -> None:
    """The router holds our provider keys and has no multi-tenant auth: plain http only on loopback."""
    u = urlparse(url)
    if u.scheme == "https" or (u.scheme == "http" and u.hostname in _LOOPBACK):
        return
    raise UpstreamError("FREELLMAPI_BASE_URL must be https, or http on localhost/127.0.0.1.")


async def call_freellmapi(prompt: str, model: str, system: str | None) -> str:
    key = _require_env("FREELLMAPI_API_KEY")
    if not FREELLMAPI_BASE_URL:
        raise UpstreamError("FREELLMAPI_BASE_URL is not set on the connector server.")
    _check_freellmapi_url(FREELLMAPI_BASE_URL)
    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
    body = {"model": model, "messages": messages, "max_tokens": MAX_OUTPUT_TOKENS}
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        resp = await client.post(
            f"{FREELLMAPI_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=body,
        )
    if resp.status_code >= 400:
        raise UpstreamError(f"FreeLLMAPI returned HTTP {resp.status_code}: {resp.text[:1000]}")
    choices = resp.json().get("choices") or []
    text = ((choices[0].get("message") or {}).get("content") or "").strip() if choices else ""
    if not text:
        raise UpstreamError("FreeLLMAPI returned no answer.")
    routed = resp.headers.get("x-routed-via")
    return text + (f"\n\n(Answered by free provider: {routed})" if routed else "")


mcp = MCPServer(
    name="jarvis-llm",
    instructions=(
        "Gives Claude access to Google Gemini. "
        "Use gemini_research for web-grounded research, gemini_ask for coding help or a quick "
        "answer from another model, and second_opinion to have Gemini double-check a report "
        "before it goes to Joshua."
    ),
)


@mcp.tool()
async def gemini_research(
    prompt: str,
    model: str | None = None,
    use_search: bool = True,
    system: str | None = None,
) -> str:
    """Research a question with Google Gemini, grounded in live Google Search results.

    Returns Gemini's answer followed by the web sources it used.
    Args:
        prompt: The research question, with any context Gemini needs.
        model: Gemini model id. Defaults to the server's GEMINI_MODEL.
        use_search: Ground the answer in Google Search (default true).
        system: Optional system instruction to steer tone or format.
    """
    try:
        try:
            return await call_gemini(prompt, model or GEMINI_MODEL, use_search, system)
        except UpstreamError as e:
            # Free-tier keys often have no Google Search grounding quota; answer without it.
            if not (use_search and "HTTP 429" in str(e)):
                raise
            text = await call_gemini(prompt, model or GEMINI_MODEL, False, system)
            return "(Google Search quota exhausted, so this answer is NOT web-grounded.)\n\n" + text
    except (UpstreamError, httpx.HTTPError) as e:
        return f"Error calling Gemini: {e}"


@mcp.tool()
async def gemini_ask(prompt: str, model: str | None = None, system: str | None = None) -> str:
    """Ask Gemini a question without web search, such as for coding help.

    Args:
        prompt: The question or task, with any code or context included.
        model: Gemini model id. Defaults to the server's GEMINI_MODEL.
        system: Optional system instruction to steer tone or format.
    """
    try:
        return await call_gemini(prompt, model or GEMINI_MODEL, False, system)
    except (UpstreamError, httpx.HTTPError) as e:
        return f"Error calling Gemini: {e}"


@mcp.tool()
async def second_opinion(report: str, focus: str | None = None, model: str | None = None) -> str:
    """Have Gemini fact-check and critique a report, plan, or code that Claude wrote.

    Uses Google Search so claims can be checked against current sources.
    Args:
        report: The full text of the report to review.
        focus: Optional area to concentrate on (for example "pricing math" or "security").
        model: Gemini model id. Defaults to the server's GEMINI_MODEL.
    """
    prompt = report if not focus else f"Focus especially on: {focus}\n\n---\n\n{report}"
    try:
        return await call_gemini(prompt, model or GEMINI_MODEL, True, SECOND_OPINION_INSTRUCTIONS)
    except (UpstreamError, httpx.HTTPError) as e:
        return f"Error calling Gemini: {e}"


if freellmapi_enabled():

    @mcp.tool()
    async def free_llm_ask(prompt: str, model: str | None = None, system: str | None = None) -> str:
        """Ask a free-tier LLM via the self-hosted FreeLLMAPI router (rotates across free providers).

        Use for drafts, brainstorming, summaries and code help. Quality and availability vary by
        the hour. Free-tier providers may log or train on prompts, so NEVER include client names,
        addresses, phone numbers, emails, prices from Notion, or any credentials.
        Args:
            prompt: The question or task, with any non-sensitive context included.
            model: "auto" (default), "auto:fast", "auto:smart", or a specific model id.
            system: Optional system instruction to steer tone or format.
        """
        try:
            return await call_freellmapi(prompt, model or FREELLMAPI_MODEL, system)
        except (UpstreamError, httpx.HTTPError) as e:
            return f"Error calling FreeLLMAPI: {e}"


class SecretPathGuard:
    """Only serves /<CONNECTOR_SECRET>/mcp and /health; everything else is a 404.

    claude.ai custom connectors take a plain URL, so the secret lives in the path.
    """

    def __init__(self, app: ASGIApp, secret: str):
        self.app = app
        self.prefix = f"/{secret}"

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path: str = scope["path"]
        if path == "/health":
            await PlainTextResponse("ok")(scope, receive, send)
            return
        head, _, rest = path[1:].partition("/")
        if not hmac.compare_digest(f"/{head}", self.prefix):
            await JSONResponse({"error": "not found"}, status_code=404)(scope, receive, send)
            return
        scope = dict(scope, path=f"/{rest}", raw_path=f"/{rest}".encode())
        await self.app(scope, receive, send)


def build_app() -> ASGIApp:
    secret = os.environ.get("CONNECTOR_SECRET", "")
    if len(secret) < 24:
        raise SystemExit("CONNECTOR_SECRET must be set to a random string of at least 24 characters.")
    allowed_hosts = [h.strip() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()]
    security = TransportSecuritySettings(
        enable_dns_rebinding_protection=bool(allowed_hosts),
        allowed_hosts=allowed_hosts,
        allowed_origins=[f"https://{h}" for h in allowed_hosts] + ["https://claude.ai"],
    )
    inner = mcp.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        transport_security=security,
    )
    return SecretPathGuard(inner, secret)


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8787"))
    app = build_app()

    # The MCP Starlette app has a lifespan (session manager) that must run.
    # access_log off: request paths contain CONNECTOR_SECRET.
    uvicorn.run(app, host=host, port=port, lifespan="on", access_log=False)


if __name__ == "__main__":
    main()
