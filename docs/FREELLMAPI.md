# Optional: free LLM providers via FreeLLMAPI

[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) (MIT) is a self-hosted router that puts many free-tier LLM
providers (Groq, Cerebras, Gemini, OpenRouter, Mistral and others) behind one OpenAI-compatible `/v1` endpoint. It rotates
across providers and keys when one is rate limited. The connector can call it through one extra tool, `free_llm_ask`.

Nothing from FreeLLMAPI is copied into this repo. The tool is **off unless both `FREELLMAPI_BASE_URL` and
`FREELLMAPI_API_KEY` are set**, so merging this changes nothing on the running server. Gemini tools are unchanged.

## Review summary (checked 2026-11-11)

| Topic | Finding |
| --- | --- |
| License | MIT, free. The router is fully free; the optional "Premium" ($19/yr or $49 once) only makes new-model catalog updates arrive 30 days sooner. **Do not buy it.** |
| Provider keys | Stored in a local SQLite file, AES-256-GCM encrypted with `ENCRYPTION_KEY` from its `.env`. Decrypted in memory per request. Treat `.env` and the Docker volume like the keys themselves. |
| Phone-home | It pulls a signed model catalog from freellmapi.co twice a day (Ed25519-verified). The project says that server never sees prompts or provider keys. Also an optional self-update via Watchtower, which mounts the Docker socket (root-equivalent), so leave that profile off. |
| Exposure | Single-user, no multi-tenant auth. The docs say not to put it on the internet. Docker publishes it on `127.0.0.1` only by default; keep it that way. The connector (secret-path URL, behind Caddy) stays the only public door. |
| Project's own stance | "Personal experimentation, not production. No SLA." Quality drops late in the day as top models hit daily caps (resets 00:00 UTC). |
| Provider terms | Your account with each provider still applies. The project's May 2026 review marks Cohere as avoid, and Gemini, NVIDIA NIM, Cloudflare and Z.ai as caution. Gemini's newer terms say "professional or business purposes", which fits High Tide Wash. **Use only Groq, Cerebras, Mistral, OpenRouter, Gemini; skip Cohere, NVIDIA NIM, Z.ai.** Verify each provider's current terms when you create its key. |
| Privacy (main risk) | Free tiers commonly allow providers to log prompts and train on them, and the router may send one conversation to a different provider each time. **Never send client names, addresses, phones, emails, quote amounts or credentials through `free_llm_ask`.** Use it for drafts, brainstorming and general questions only. This matches the Jarvis rule that Notion is the source of truth and client data stays out of third parties. |
| Reliability | Not suitable as the only model for anything client-facing. Nothing it produces goes to a client without Approvals, as always. |

## Setup on the Oracle VM (needs Joshua; do not run before he agrees)

1. Install Docker if missing, then follow FreeLLMAPI's [install guide](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/install/01-install.md)
   (Docker Compose). Do not set `HOST_BIND`; leave it on 127.0.0.1:3001. Do not enable the `autoupdate` profile.
2. Over an SSH tunnel (`ssh -L 3001:127.0.0.1:3001 ubuntu@<vm>`) open http://localhost:3001, create the account, and on **Keys**
   add free keys from the providers listed above. Copy the unified key (`freellmapi-...`).
3. Add to `/etc/jarvis-llm/env`:
   ```
   FREELLMAPI_BASE_URL=http://127.0.0.1:3001/v1
   FREELLMAPI_API_KEY=freellmapi-...
   ```
   then `sudo systemctl restart jarvis-llm`. Claude now lists a fourth tool, `free_llm_ask`.
4. To turn it off: remove those two lines and restart.

`FREELLMAPI_BASE_URL` must be `https`, or `http` on localhost; the connector refuses plain http to any other host.
`model` can be `auto` (default), `auto:fast`, `auto:smart`, or a specific model id.
