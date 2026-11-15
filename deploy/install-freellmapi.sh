#!/usr/bin/env bash
# Optional: install the self-hosted FreeLLMAPI router on the Oracle VM and (separately) turn on free_llm_ask.
# Read docs/FREELLMAPI.md first. Run only after Joshua agrees; nothing here runs automatically.
#
#   bash deploy/install-freellmapi.sh install   # step 1: router in Docker, bound to 127.0.0.1:3001 only
#   bash deploy/install-freellmapi.sh enable    # step 3: prompts for the unified key, turns the tool on
#   bash deploy/install-freellmapi.sh disable   # turns the tool off again
#
# Step 2 (create the account and add free provider keys) is done by hand over an SSH tunnel:
#   ssh -L 3001:127.0.0.1:3001 ubuntu@<vm>   then open http://localhost:3001
set -euo pipefail

DIR="${FREELLMAPI_DIR:-$HOME/freellmapi}"
ENVFILE=/etc/jarvis-llm/env

case "${1:-}" in
install)
  command -v docker >/dev/null || { echo "Docker is required. Install it first (https://docs.docker.com/engine/install/ubuntu/)."; exit 1; }
  docker compose version >/dev/null || { echo "Docker Compose plugin is required."; exit 1; }
  [ -z "${HOST_BIND:-}" ] || { echo "Unset HOST_BIND: the router must stay on 127.0.0.1."; exit 1; }
  [ -d "$DIR/.git" ] || git clone https://github.com/tashfeenahmed/freellmapi.git "$DIR"
  cd "$DIR"
  if [ ! -f .env ]; then
    ( umask 077; printf 'ENCRYPTION_KEY=%s\nPORT=3001\n' "$(openssl rand -hex 32)" > .env )
  else
    echo ".env exists; keeping it (it holds the encryption key for stored provider keys)."
  fi
  # No --profile autoupdate: that profile mounts the Docker socket (root-equivalent).
  docker compose up -d
  sleep 5
  curl -fsS http://127.0.0.1:3001/api/ping >/dev/null && echo "Router is up on 127.0.0.1:3001."
  if ss -ltn 2>/dev/null | grep -E ':3001\b' | grep -vq '127.0.0.1'; then
    echo "WARNING: port 3001 is listening on a non-loopback address. Fix before continuing."; exit 1
  fi
  echo "Next: SSH tunnel, create the account, add keys (Groq, Cerebras, Mistral, OpenRouter, Gemini), copy the unified key, then run: $0 enable"
  ;;
enable)
  read -rsp "FreeLLMAPI unified key (freellmapi-...): " KEY </dev/tty; echo
  [ -n "$KEY" ] || { echo "Key is required"; exit 1; }
  sudo sed -i '/^FREELLMAPI_/d' "$ENVFILE"
  printf 'FREELLMAPI_BASE_URL=http://127.0.0.1:3001/v1\nFREELLMAPI_API_KEY=%s\n' "$KEY" | sudo tee -a "$ENVFILE" >/dev/null
  sudo systemctl restart jarvis-llm
  echo "free_llm_ask is on. Remember: never send client names, addresses, phones, emails, quote amounts or credentials through it."
  ;;
disable)
  sudo sed -i '/^FREELLMAPI_/d' "$ENVFILE"
  sudo systemctl restart jarvis-llm
  echo "free_llm_ask is off."
  ;;
*)
  echo "usage: $0 install | enable | disable"; exit 2 ;;
esac
