"""Fake Gemini and OpenAI endpoints for local testing. Records requests for assertions."""

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

received: list[dict] = []


async def gemini(request: Request):
    body = await request.json()
    received.append({"api": "gemini", "path": request.url.path, "key": request.headers.get("x-goog-api-key"), "body": body})
    if request.headers.get("x-goog-api-key") != "test-gemini-key":
        return JSONResponse({"error": {"message": "API key not valid"}}, status_code=400)
    prompt = body["contents"][0]["parts"][0]["text"]
    return JSONResponse({
        "candidates": [{
            "content": {"role": "model", "parts": [{"text": f"Gemini says: researched '{prompt}'."}]},
            "groundingMetadata": {"groundingChunks": [
                {"web": {"uri": "https://example.com/a", "title": "Example A"}},
                {"web": {"uri": "https://example.com/a", "title": "Example A"}},
            ]},
        }]
    })


async def openai(request: Request):
    body = await request.json()
    received.append({"api": "openai", "auth": request.headers.get("authorization"), "body": body})
    if request.headers.get("authorization") != "Bearer test-openai-key":
        return JSONResponse({"error": {"message": "Incorrect API key"}}, status_code=401)
    return JSONResponse({
        "status": "completed",
        "output": [
            {"type": "reasoning", "summary": []},
            {"type": "message", "content": [{"type": "output_text", "text": f"ChatGPT ({body['model']}) says: {body['input'][:40]}"}]},
        ],
    })


async def dump(request: Request):
    return JSONResponse(received)


app = Starlette(routes=[
    Route("/v1beta/models/{model}:generateContent", gemini, methods=["POST"]),
    Route("/v1/responses", openai, methods=["POST"]),
    Route("/_received", dump),
])
