# Jarvis LLM connector

A small remote MCP server that lets Claude (claude.ai, Claude Code, Cowork) call Google Gemini and OpenAI ChatGPT.

| Tool | What it does |
| --- | --- |
| `gemini_research(prompt, model?, use_search?, system?)` | Research with Gemini, grounded in live Google Search. Returns the answer plus source links. |
| `chatgpt_ask(prompt, model?, system?)` | Ask a ChatGPT model anything, such as coding help. |
| `second_opinion(report, focus?, model?)` | Have ChatGPT fact-check a report, plan, or code Claude wrote. Ends with a verdict: AGREE, AGREE WITH CHANGES, or DISAGREE. |

API keys are read from environment variables only. Nothing secret lives in this repo.

## What you need

- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com/app/apikey).
- An **OpenAI API key** from [platform.openai.com/api-keys](https://platform.openai.com/api-keys). This is billed separately from a ChatGPT Plus subscription; add a payment method and set a monthly limit under Billing.
- A host. These steps use the existing Oracle Cloud Ubuntu VM that already runs Caddy for `ops.hightidewash.net`.

## Quick deploy (recommended)

1. In Squarespace, add an `llm` `A` record pointing at the VM's public IP.
2. SSH into the VM and run `git clone https://github.com/joshspicy2/jarvis-llm-connector && bash jarvis-llm-connector/deploy/install.sh` (it prompts for the keys, installs everything, and prints your connector URL). The OpenAI key can be skipped; only `gemini_research` works until it's added.
3. Add the printed URL in claude.ai (see "Add it to Claude" below).

## Manual deploy on the Oracle VM

1. **DNS.** In Squarespace, add an `A` record for `llm` pointing at the VM's public IP (the same IP `ops` uses).

2. **Install the code.** SSH into the VM:

   ```bash
   sudo apt-get install -y python3-venv git
   sudo useradd --system --no-create-home jarvis-llm
   sudo git clone https://github.com/joshspicy2/jarvis-llm-connector.git /opt/jarvis-llm-connector
   cd /opt/jarvis-llm-connector
   sudo python3 -m venv .venv
   sudo .venv/bin/pip install -r requirements.txt
   ```

   If the repo is private, clone it with a GitHub deploy key or a fine-grained token, or `scp` the folder up.

3. **Add the keys.** Never commit these.

   ```bash
   sudo mkdir -p /etc/jarvis-llm
   sudo cp .env.example /etc/jarvis-llm/env
   python3 -c "import secrets; print(secrets.token_urlsafe(32))"   # copy this into CONNECTOR_SECRET
   sudo nano /etc/jarvis-llm/env                                    # fill in both API keys and CONNECTOR_SECRET
   sudo chown root:jarvis-llm /etc/jarvis-llm/env
   sudo chmod 640 /etc/jarvis-llm/env
   ```

4. **Run it as a service.**

   ```bash
   sudo cp deploy/jarvis-llm.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now jarvis-llm
   curl http://127.0.0.1:8787/health        # prints: ok
   ```

5. **Put it behind Caddy.** Append `deploy/Caddyfile.snippet` to `/etc/caddy/Caddyfile`, then:

   ```bash
   sudo systemctl reload caddy
   curl https://llm.hightidewash.net/health   # prints: ok (Caddy gets the HTTPS cert automatically)
   ```

   Ports 80 and 443 are already open on the VM for `ops`, so no Oracle security-list changes are needed.

Your connector URL is:

```
https://llm.hightidewash.net/<CONNECTOR_SECRET>/mcp
```

Treat that URL like a password. Anyone with it can spend your API credits. Any other path returns 404.

## Add it to Claude

1. Open [claude.ai/settings/connectors](https://claude.ai/settings/connectors) (Settings → Connectors).
2. Click **Add custom connector**.
3. Name it `Jarvis LLM` and paste the connector URL above. Leave the OAuth fields empty.
4. Click **Add**. In a chat, enable it from the tools menu (the sliders icon) and allow the three tools.

The same connector then appears in Claude Code on the web and Cowork for your account. For local Claude Code you can also run:

```bash
claude mcp add --transport http jarvis-llm https://llm.hightidewash.net/<CONNECTOR_SECRET>/mcp
```

## Updating

```bash
cd /opt/jarvis-llm-connector && sudo git pull && sudo .venv/bin/pip install -r requirements.txt && sudo systemctl restart jarvis-llm
```

To rotate a key or the secret, edit `/etc/jarvis-llm/env`, run `sudo systemctl restart jarvis-llm`, and (for a new secret) update the URL in Claude's connector settings.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | none | Required for `gemini_research`. |
| `OPENAI_API_KEY` | none | Required for `chatgpt_ask` and `second_opinion`. |
| `CONNECTOR_SECRET` | none | Required, at least 24 characters. Forms part of the URL. |
| `ALLOWED_HOSTS` | none | Public hostname(s), comma separated. Enables DNS-rebinding protection. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Default Gemini model; any call can override it. |
| `OPENAI_MODEL` | `gpt-5` | Default OpenAI model; any call can override it. |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Keep it on localhost; Caddy handles the public side. |
| `REQUEST_TIMEOUT_SECONDS` | `180` | Per upstream call. |
| `MAX_OUTPUT_TOKENS` | `8000` | Caps each answer to control cost. |

## Local development and tests

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest -q
```

The tests start the real server and a fake Gemini/OpenAI server (`tests/mock_upstream.py`), then drive it with the official MCP client. No real keys or network calls are used.

## Troubleshooting

- `journalctl -u jarvis-llm -f` shows server logs. Access logs are off on purpose, since the path contains the secret.
- A tool answer starting with `Error calling Gemini` or `Error calling OpenAI` includes the upstream HTTP status: 400/401 means a bad key, 429 means quota or billing.
- `421 Misdirected Request` or `Invalid Host header` means `ALLOWED_HOSTS` doesn't match the hostname in the URL.
