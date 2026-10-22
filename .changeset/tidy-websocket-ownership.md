---
'ai-sdk-openai-websocket-fetch': patch
---

Bind reusable WebSocket connections to their Authorization header and give each active request exclusive ownership of its connection. Close superseded, cancelled, and pending connections when they can no longer be reused.
