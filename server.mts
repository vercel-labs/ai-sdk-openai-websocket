import { createServer } from 'node:http';
import { parse } from 'node:url';
import next from 'next';
import WebSocket, { WebSocketServer } from 'ws';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const OPENAI_WS_URL = 'wss://api.openai.com/v1/responses';
const MODEL = 'gpt-4.1-mini';

interface MessagePart {
  type: string;
  text?: string;
}

interface ClientMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
}

function convertToOpenAIInput(messages: ClientMessage[]) {
  return messages.map(m => {
    const textParts = m.parts.filter(
      (p): p is MessagePart & { text: string } =>
        p.type === 'text' && typeof p.text === 'string',
    );
    const contentType = m.role === 'assistant' ? 'output_text' : 'input_text';
    return {
      type: 'message',
      role: m.role,
      content: textParts.map(p => ({ type: contentType, text: p.text })),
    };
  });
}

function connectToOpenAI(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(OPENAI_WS_URL, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res, parse(req.url!, true));
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = parse(request.url!, true);
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', clientWs => {
    let openaiWs: WebSocket | null = null;
    let previousResponseId: string | null = null;

    // Permanent listener to always track previousResponseId
    function trackResponseId(raw: WebSocket.RawData) {
      try {
        const event = JSON.parse(raw.toString());
        if (event.type === 'response.completed') {
          previousResponseId = event.response.id;
        }
      } catch {
        // ignore parse errors
      }
    }

    async function ensureOpenAI(): Promise<WebSocket> {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        return openaiWs;
      }
      openaiWs = await connectToOpenAI();
      openaiWs.on('message', trackResponseId);
      openaiWs.on('close', () => {
        openaiWs = null;
      });
      return openaiWs;
    }

    clientWs.on('message', async (raw: WebSocket.RawData) => {
      try {
        const { requestId, messages } = JSON.parse(raw.toString()) as {
          requestId: string;
          messages: ClientMessage[];
        };

        const ws = await ensureOpenAI();

        // Build OpenAI input
        let input;
        if (previousResponseId) {
          // Incremental: only send the last user message
          const lastUserMessage = [...messages]
            .reverse()
            .find(m => m.role === 'user');
          input = lastUserMessage
            ? convertToOpenAIInput([lastUserMessage])
            : [];
        } else {
          input = convertToOpenAIInput(messages);
        }

        const textPartId = `text-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        let isFirstDelta = true;

        function send(chunk: Record<string, unknown>) {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ requestId, chunk }));
          }
        }

        function onOpenAIMessage(rawMsg: WebSocket.RawData) {
          try {
            const event = JSON.parse(rawMsg.toString());

            switch (event.type) {
              case 'response.created':
                send({
                  type: 'start',
                  messageId: `msg-${event.response.id}`,
                });
                send({ type: 'start-step' });
                break;

              case 'response.output_text.delta':
                if (isFirstDelta) {
                  send({ type: 'text-start', id: textPartId });
                  isFirstDelta = false;
                }
                send({
                  type: 'text-delta',
                  id: textPartId,
                  delta: event.delta,
                });
                break;

              case 'response.output_text.done':
                send({ type: 'text-end', id: textPartId });
                break;

              case 'response.completed':
                send({ type: 'finish-step' });
                send({ type: 'finish', finishReason: 'stop' });
                ws.off('message', onOpenAIMessage);
                break;

              case 'error':
                send({
                  type: 'error',
                  errorText: event.error?.message ?? 'Unknown OpenAI error',
                });
                ws.off('message', onOpenAIMessage);
                break;
            }
          } catch {
            // ignore parse errors
          }
        }

        ws.on('message', onOpenAIMessage);

        const body: Record<string, unknown> = {
          type: 'response.create',
          model: MODEL,
          input,
        };
        if (previousResponseId) {
          body.previous_response_id = previousResponseId;
        }

        ws.send(JSON.stringify(body));
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Internal server error';
        clientWs.send(
          JSON.stringify({
            requestId: 'error',
            chunk: { type: 'error', errorText: errorMessage },
          }),
        );
      }
    });

    clientWs.on('close', () => {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });
  });

  const port = parseInt(process.env.PORT ?? '3000', 10);
  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});
