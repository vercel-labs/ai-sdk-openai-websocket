# ai-sdk-openai-websocket-fetch

> **Deprecated:** This demo package is no longer maintained. WebSocket support is
> now built into [AI SDK](https://ai-sdk.dev). Use AI SDK directly instead of
> `ai-sdk-openai-websocket-fetch` or `@vercel/ai-sdk-openai-websocket-fetch`.

Drop-in `fetch` replacement that routes OpenAI Responses API streaming requests through a persistent WebSocket connection instead of HTTP.

## Installation

```bash
npm install ai-sdk-openai-websocket-fetch
```

## Usage

```ts
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createWebSocketFetch } from 'ai-sdk-openai-websocket-fetch';

const wsFetch = createWebSocketFetch();
const openai = createOpenAI({ fetch: wsFetch });

const result = streamText({
  model: openai('gpt-4.1-mini'),
  prompt: 'Hello!',
  onFinish: () => wsFetch.close(),
});
```

An idle connection is reused only for requests with the same `Authorization`
header. Concurrent requests use separate connections, including while a
connection is opening. The wrapper retains at most one idle connection; call
`wsFetch.close()` when finished to close all of its open and pending connections.

## Why?

OpenAI's WebSocket API keeps a persistent connection open. After the initial handshake, subsequent requests skip TCP/TLS/HTTP negotiation entirely — reducing TTFB in multi-step agentic workflows where the model makes many tool calls.

## License

MIT
