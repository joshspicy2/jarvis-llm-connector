#!/usr/bin/env bash
# One-shot installer for the Oracle Ubuntu VM. Run as a user with sudo:
#   curl -fsSL https://raw.githubusercontent.com/joshspicy2/jarvis-llm-connector/main/deploy/install.sh | bash
# (repo is private? clone it first and run: bash deploy/install.sh)
# Prompts for the Gemini key (and optionally an OpenAI key); nothing is written to the repo.
set -euo pipefail

DOMAIN="${DOMAIN:-llm.hightidewash.net}"
APP=/opt/jarvis-llm-connector
ENVFILE=/etc/jarvis-llm/env

read -rsp "Gemini API key: " GEMINI_KEY </dev/tty; echo
read -rsp "OpenAI API key (press Enter to skip for now): " OPENAI_KEY </dev/tty; echo
[ -n "$GEMINI_KEY" ] || { echo "Gemini key is required"; exit 1; }

sudo apt-get install -y python3-venv git >/dev/null
id jarvis-llm >/dev/null 2>&1 || sudo useradd --system --no-create-home jarvis-llm
if [ -d "$APP/.git" ]; then sudo git -C "$APP" pull -q; else sudo git clone -q https://github.com/joshspicy2/jarvis-llm-connector.git "$APP"; fi
sudo python3 -m venv "$APP/.venv"
sudo "$APP/.venv/bin/pip" install -q -r "$APP/requirements.txt"

sudo mkdir -p /etc/jarvis-llm
if [ ! -f "$ENVFILE" ]; then
  SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
  sudo tee "$ENVFILE" >/dev/null <<ENV
GEMINI_API_KEY=$GEMINI_KEY
OPENAI_API_KEY=$OPENAI_KEY
CONNECTOR_SECRET=$SECRET
ALLOWED_HOSTS=$DOMAIN
ENV
  sudo chown root:jarvis-llm "$ENVFILE"; sudo chmod 640 "$ENVFILE"
else
  echo "$ENVFILE already exists; keeping it (edit it by hand to change keys)."
fi

sudo cp "$APP/deploy/jarvis-llm.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis-llm
sudo systemctl restart jarvis-llm

if ! sudo grep -q "$DOMAIN" /etc/caddy/Caddyfile; then
  sudo tee -a /etc/caddy/Caddyfile <"$APP/deploy/Caddyfile.snippet" >/dev/null
fi
sudo systemctl reload caddy

sleep 2
curl -fsS http://127.0.0.1:8787/health >/dev/null && echo "Server is up."
SECRET=$(sudo grep '^CONNECTOR_SECRET=' "$ENVFILE" | cut -d= -f2)
echo
echo "Paste this URL into claude.ai > Settings > Connectors > Add custom connector:"
echo "  https://$DOMAIN/$SECRET/mcp"
