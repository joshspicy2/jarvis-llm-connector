// Jarvis dashboard config. No credentials belong in this file: it is public.
// Endpoints are n8n Webhook-node URLs; protect them in n8n (e.g. unguessable path
// or Caddy-level auth), never by embedding secrets here.
window.JARVIS_CONFIG = {
  N8N_BASE: "https://ops.hightidewash.net/webhook",
  ENDPOINTS: {
    pipeline:  { method: "GET",  path: "/jarvis/pipeline" },
    agents:    { method: "GET",  path: "/jarvis/agents" },
    rules:     { method: "GET",  path: "/jarvis/estimate-rules" },
    warMode:   { method: "GET",  path: "/jarvis/war-mode" },
    setWarMode:{ method: "POST", path: "/jarvis/war-mode" },
    approvals: { method: "GET",  path: "/jarvis/approvals" },
    log:       { method: "GET",  path: "/jarvis/activity-log" },
    chat:      { method: "POST", path: "/jarvis/chat" },
  },
  POLL_MS: 30000,
  TIMEOUT_MS: 6000,
  CHAT_TIMEOUT_MS: 45000,
  // Set true to skip network calls and always show sample data.
  FORCE_SAMPLE: false,
};
