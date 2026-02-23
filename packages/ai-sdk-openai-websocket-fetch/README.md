# ai-sdk-openai-websocket-fetch

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

## Why?

OpenAI's WebSocket API keeps a persistent connection open. After the initial handshake, subsequent requests skip TCP/TLS/HTTP negotiation entirely — reducing TTFB in multi-step agentic workflows where the model makes many tool calls.

## License

MIT
