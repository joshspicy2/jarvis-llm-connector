"""Fake Gemini endpoint for local testing. Records requests for assertions."""

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


async def dump(request: Request):
    return JSONResponse(received)


app = Starlette(routes=[
    Route("/v1beta/models/{model}:generateContent", gemini, methods=["POST"]),
    Route("/_received", dump),
])
