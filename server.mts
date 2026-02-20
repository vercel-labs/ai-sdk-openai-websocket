import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parse } from 'node:url';
import { join } from 'node:path';
import next from 'next';
import WebSocket, { WebSocketServer } from 'ws';
import { createBashTool } from 'bash-tool';
import { loadDocsFromDisk } from './lib/load-docs.mts';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const OPENAI_WS_URL = 'wss://api.openai.com/v1/responses';
const MODEL = 'gpt-4.1-mini';
const MAX_STEPS = 30;

// Load docs once at startup
const docsDir = join(import.meta.dirname, 'content', 'docs');
const docsFiles = loadDocsFromDisk(docsDir);
console.log(`Loaded ${Object.keys(docsFiles).length} doc files from ${docsDir}`);

const SYSTEM_PROMPT = `You are an AI SDK documentation assistant. You have access to the Vercel AI SDK documentation in /workspace/docs/. Use your tools to explore the docs, answer questions, and create or modify documentation files.

Always start by exploring the available files to understand the structure before answering. Use bash commands like ls, find, and grep to explore, then read specific files for details.

When writing new documentation, follow the patterns and conventions you observe in the existing docs.`;

const toolDefinitions = [
  {
    type: 'function' as const,
    name: 'bash',
    description:
      'Execute a bash command in the workspace. Available commands: ls, cat, head, tail, find, grep, sed, echo, mkdir, cp, mv, rm, wc, sort, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
      },
      required: ['command'],
    },
  },
  {
    type: 'function' as const,
    name: 'readFile',
    description: 'Read the contents of a file at the given path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
      },
      required: ['path'],
    },
  },
  {
    type: 'function' as const,
    name: 'writeFile',
    description:
      'Write content to a file, creating it and parent dirs if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  },
];

interface MessagePart {
  type: string;
  text?: string;
}

interface ClientMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
}

interface PendingToolCall {
  call_id: string;
  name: string;
  arguments: string;
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

async function createTools() {
  const files: Record<string, string> = {};
  for (const [name, content] of Object.entries(docsFiles)) {
    files[`docs/${name}`] = content;
  }
  const { tools } = await createBashTool({ files });
  return tools;
}

// --- HTTP streaming endpoint ---

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';

const httpSessions = new Map<
  string,
  {
    previousResponseId: string | null;
    bashToolsPromise: Promise<Record<string, any>> | null;
  }
>();

async function handleHttpChat(req: IncomingMessage, res: ServerResponse) {
  const rawBody = await new Promise<string>((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

  const { sessionId, messages } = JSON.parse(rawBody) as {
    sessionId: string;
    messages: ClientMessage[];
  };

  console.log(
    `[http] Request sessionId=${sessionId}, ${messages.length} messages`,
  );

  if (!httpSessions.has(sessionId)) {
    httpSessions.set(sessionId, {
      previousResponseId: null,
      bashToolsPromise: null,
    });
  }
  const session = httpSessions.get(sessionId)!;

  if (!session.bashToolsPromise) {
    session.bashToolsPromise = createTools();
  }
  const bashTools = await session.bashToolsPromise;

  let input;
  if (session.previousResponseId) {
    const lastUserMessage = [...messages]
      .reverse()
      .find(m => m.role === 'user');
    input = lastUserMessage ? convertToOpenAIInput([lastUserMessage]) : [];
  } else {
    input = convertToOpenAIInput(messages);
  }

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let cumulativeTokens = { input: 0, inputCached: 0, output: 0 };
  let stepCount = 0;
  let isFirstResponse = true;

  function send(chunk: Record<string, unknown>) {
    if (!res.destroyed) {
      res.write(JSON.stringify(chunk) + '\n');
    }
  }

  async function runStep(
    stepInput: unknown[],
    prevResponseId: string | null,
  ): Promise<void> {
    const requestBody: Record<string, unknown> = {
      model: MODEL,
      instructions: SYSTEM_PROMPT,
      tools: toolDefinitions,
      input: stepInput,
      stream: true,
    };
    if (prevResponseId) {
      requestBody.previous_response_id = prevResponseId;
    }

    console.log('[http] Sending request to OpenAI');
    const apiResponse = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error(
        `[http] OpenAI API error: ${apiResponse.status}`,
        errorText.substring(0, 200),
      );
      send({
        type: 'error',
        errorText: `OpenAI API error: ${apiResponse.status}`,
      });
      return;
    }

    const reader = apiResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let pendingToolCalls: PendingToolCall[] = [];
    let textPartId = '';
    let isFirstDelta = true;
    let completedEvent: any = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let eventEnd;
      while ((eventEnd = buffer.indexOf('\n\n')) !== -1) {
        const eventText = buffer.slice(0, eventEnd);
        buffer = buffer.slice(eventEnd + 2);

        const dataLine = eventText
          .split('\n')
          .find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        const data = dataLine.slice(6);
        if (data === '[DONE]') continue;

        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        switch (event.type) {
          case 'response.created':
            if (isFirstResponse) {
              send({
                type: 'start',
                messageId: `msg-${event.response.id}`,
              });
              isFirstResponse = false;
            }
            send({ type: 'start-step' });
            break;

          case 'response.output_text.delta':
            if (isFirstDelta) {
              textPartId = `text-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
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

          case 'response.output_item.added':
            if (event.item?.type === 'function_call') {
              send({
                type: 'tool-input-start',
                toolCallId: `tool-${event.item.call_id}`,
                toolName: event.item.name,
                dynamic: true,
              });
              pendingToolCalls.push({
                call_id: event.item.call_id,
                name: event.item.name,
                arguments: '',
              });
            }
            break;

          case 'response.function_call_arguments.delta': {
            const tc = pendingToolCalls.find(
              t => t.call_id === event.item_id,
            );
            if (tc) {
              send({
                type: 'tool-input-delta',
                toolCallId: `tool-${tc.call_id}`,
                inputTextDelta: event.delta,
              });
            }
            break;
          }

          case 'response.output_item.done':
            if (event.item?.type === 'function_call') {
              const tc = pendingToolCalls.find(
                t => t.call_id === event.item.call_id,
              );
              if (tc) {
                tc.arguments = event.item.arguments;
                let parsedInput: unknown;
                try {
                  parsedInput = JSON.parse(tc.arguments);
                } catch {
                  parsedInput = tc.arguments;
                }
                send({
                  type: 'tool-input-available',
                  toolCallId: `tool-${tc.call_id}`,
                  toolName: tc.name,
                  input: parsedInput,
                  dynamic: true,
                });
              }
            }
            break;

          case 'response.completed':
            completedEvent = event;
            break;

          case 'error':
            send({
              type: 'error',
              errorText: event.error?.message ?? 'Unknown OpenAI error',
            });
            return;
        }
      }
    }

    if (!completedEvent) return;

    session.previousResponseId = completedEvent.response.id;

    const usage = completedEvent.response.usage;
    if (usage) {
      cumulativeTokens.input += usage.input_tokens ?? 0;
      cumulativeTokens.inputCached +=
        usage.input_tokens_details?.cached_tokens ?? 0;
      cumulativeTokens.output += usage.output_tokens ?? 0;
    }
    send({
      type: 'data-stats',
      data: { tokens: { ...cumulativeTokens } },
    });

    const functionCalls = (completedEvent.response.output || []).filter(
      (o: { type: string }) => o.type === 'function_call',
    );

    if (functionCalls.length > 0 && stepCount < MAX_STEPS) {
      stepCount++;

      const toolOutputs: {
        type: string;
        call_id: string;
        output: string;
      }[] = [];

      for (const fc of functionCalls) {
        let args: Record<string, string> = {};
        try {
          args = JSON.parse(fc.arguments);
        } catch {
          // ignore parse errors
        }

        let result: string;
        try {
          console.log(
            `[http/tool] Executing ${fc.name}:`,
            JSON.stringify(args).substring(0, 200),
          );
          const toolResult = await bashTools[fc.name].execute(args);
          result =
            typeof toolResult === 'string'
              ? toolResult
              : JSON.stringify(toolResult);
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }

        const truncatedResult =
          result.length > 10000
            ? result.substring(0, 10000) + '\n... (truncated)'
            : result;

        send({
          type: 'tool-output-available',
          toolCallId: `tool-${fc.call_id}`,
          output: truncatedResult,
          dynamic: true,
        });

        toolOutputs.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: truncatedResult,
        });
      }

      send({ type: 'finish-step' });
      await runStep(toolOutputs, session.previousResponseId);
    } else {
      send({ type: 'finish-step' });
      send({ type: 'finish', finishReason: 'stop' });
    }
  }

  try {
    await runStep(input, session.previousResponseId);
  } catch (err) {
    console.error('[http] Error:', err);
    send({
      type: 'error',
      errorText: err instanceof Error ? err.message : 'Internal error',
    });
  } finally {
    if (!res.destroyed) {
      res.end();
    }
  }
}

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    const { pathname } = parse(req.url!, true);
    if (pathname === '/api/chat' && req.method === 'POST') {
      try {
        await handleHttpChat(req, res);
      } catch (err) {
        console.error('[http] Unhandled error:', err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal server error');
        }
      }
      return;
    }
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
    console.log('[ws] Client connected');
    let openaiWs: WebSocket | null = null;
    let previousResponseId: string | null = null;

    // Each client gets its own bash tools instance (created lazily)
    let bashToolsPromise: Promise<Record<string, any>> | null = null;
    function getBashTools() {
      if (!bashToolsPromise) {
        console.log('[ws] Creating bash tools...');
        bashToolsPromise = createTools().then(tools => {
          console.log('[ws] Bash tools ready');
          return tools;
        });
      }
      return bashToolsPromise;
    }

    async function ensureOpenAI(): Promise<WebSocket> {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        return openaiWs;
      }
      console.log('[ws] Connecting to OpenAI...');
      openaiWs = await connectToOpenAI();
      console.log('[ws] OpenAI connected');
      openaiWs.on('close', (code, reason) => {
        console.log(`[ws] OpenAI disconnected: ${code} ${reason}`);
        openaiWs = null;
      });
      openaiWs.on('error', err => {
        console.error('[ws] OpenAI WS error:', err.message);
      });
      return openaiWs;
    }

    clientWs.on('message', async (raw: WebSocket.RawData) => {
      try {
        const { requestId, messages } = JSON.parse(raw.toString()) as {
          requestId: string;
          messages: ClientMessage[];
        };
        console.log(`[ws] Received message requestId=${requestId}, ${messages.length} messages`);

        const [ws, bashTools] = await Promise.all([
          ensureOpenAI(),
          getBashTools(),
        ]);
        console.log('[ws] OpenAI + bash tools ready');

        // Build OpenAI input
        let input;
        if (previousResponseId) {
          const lastUserMessage = [...messages]
            .reverse()
            .find(m => m.role === 'user');
          input = lastUserMessage
            ? convertToOpenAIInput([lastUserMessage])
            : [];
        } else {
          input = convertToOpenAIInput(messages);
        }

        let stepCount = 0;
        let cumulativeTokens = { input: 0, inputCached: 0, output: 0 };

        function send(chunk: Record<string, unknown>) {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ requestId, chunk }));
          }
        }

        function handleOpenAIResponse(
          ws: WebSocket,
          input: unknown[],
          prevResponseId: string | null,
          isFirstResponse: boolean,
        ) {
          let pendingToolCalls: PendingToolCall[] = [];
          let textPartId = '';
          let isFirstDelta = true;

          function onMessage(rawMsg: WebSocket.RawData) {
            try {
              const event = JSON.parse(rawMsg.toString());
              console.log(`[openai] Event: ${event.type}`);

              switch (event.type) {
                case 'response.created':
                  if (isFirstResponse) {
                    send({
                      type: 'start',
                      messageId: `msg-${event.response.id}`,
                    });
                  }
                  send({ type: 'start-step' });
                  break;

                case 'response.output_text.delta':
                  if (isFirstDelta) {
                    textPartId = `text-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
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

                case 'response.output_item.added':
                  if (event.item?.type === 'function_call') {
                    send({
                      type: 'tool-input-start',
                      toolCallId: `tool-${event.item.call_id}`,
                      toolName: event.item.name,
                      dynamic: true,
                    });
                    pendingToolCalls.push({
                      call_id: event.item.call_id,
                      name: event.item.name,
                      arguments: '',
                    });
                  }
                  break;

                case 'response.function_call_arguments.delta': {
                  const tc = pendingToolCalls.find(
                    t => t.call_id === event.item_id,
                  );
                  if (tc) {
                    const toolCallId = `tool-${tc.call_id}`;
                    send({
                      type: 'tool-input-delta',
                      toolCallId,
                      inputTextDelta: event.delta,
                    });
                  }
                  break;
                }

                case 'response.output_item.done':
                  if (event.item?.type === 'function_call') {
                    const tc = pendingToolCalls.find(
                      t => t.call_id === event.item.call_id,
                    );
                    if (tc) {
                      tc.arguments = event.item.arguments;
                      let parsedInput: unknown;
                      try {
                        parsedInput = JSON.parse(tc.arguments);
                      } catch {
                        parsedInput = tc.arguments;
                      }
                      send({
                        type: 'tool-input-available',
                        toolCallId: `tool-${tc.call_id}`,
                        toolName: tc.name,
                        input: parsedInput,
                        dynamic: true,
                      });
                    }
                  }
                  break;

                case 'response.completed': {
                  previousResponseId = event.response.id;
                  ws.off('message', onMessage);

                  // Track cumulative token usage
                  const usage = event.response.usage;
                  if (usage) {
                    cumulativeTokens.input += usage.input_tokens ?? 0;
                    cumulativeTokens.inputCached += usage.input_tokens_details?.cached_tokens ?? 0;
                    cumulativeTokens.output += usage.output_tokens ?? 0;
                  }
                  send({ type: 'data-stats', data: { tokens: { ...cumulativeTokens } } });

                  // Check if there are function calls to handle
                  const functionCalls = (event.response.output || []).filter(
                    (o: { type: string }) => o.type === 'function_call',
                  );

                  if (functionCalls.length > 0 && stepCount < MAX_STEPS) {
                    stepCount++;

                    // Execute tools and continue
                    (async () => {
                      const toolOutputs: {
                        type: string;
                        call_id: string;
                        output: string;
                      }[] = [];

                      for (const fc of functionCalls) {
                        let args: Record<string, string> = {};
                        try {
                          args = JSON.parse(fc.arguments);
                        } catch {
                          // ignore parse errors
                        }

                        let result: string;
                        try {
                          console.log(`[tool] Executing ${fc.name}:`, JSON.stringify(args).substring(0, 200));
                          const toolResult = await bashTools[fc.name].execute(args);
                          result =
                            typeof toolResult === 'string'
                              ? toolResult
                              : JSON.stringify(toolResult);
                        } catch (err) {
                          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
                        }

                        const toolCallId = `tool-${fc.call_id}`;

                        // Truncate very long results
                        const truncatedResult =
                          result.length > 10000
                            ? result.substring(0, 10000) + '\n... (truncated)'
                            : result;

                        send({
                          type: 'tool-output-available',
                          toolCallId,
                          output: truncatedResult,
                          dynamic: true,
                        });

                        toolOutputs.push({
                          type: 'function_call_output',
                          call_id: fc.call_id,
                          output: truncatedResult,
                        });
                      }

                      // Finish current step, start next
                      send({ type: 'finish-step' });

                      // Continue the conversation with tool results
                      handleOpenAIResponse(
                        ws,
                        toolOutputs,
                        previousResponseId,
                        false,
                      );

                      const continueBody: Record<string, unknown> = {
                        type: 'response.create',
                        model: MODEL,
                        instructions: SYSTEM_PROMPT,
                        tools: toolDefinitions,
                        input: toolOutputs,
                      };
                      if (previousResponseId) {
                        continueBody.previous_response_id =
                          previousResponseId;
                      }
                      ws.send(JSON.stringify(continueBody));
                    })();
                  } else {
                    // No tool calls or max steps reached — done
                    send({ type: 'finish-step' });
                    send({ type: 'finish', finishReason: 'stop' });
                  }
                  break;
                }

                case 'error':
                  send({
                    type: 'error',
                    errorText:
                      event.error?.message ?? 'Unknown OpenAI error',
                  });
                  ws.off('message', onMessage);
                  break;
              }
            } catch (err) {
              console.error('[openai] Error processing event:', err);
            }
          }

          ws.on('message', onMessage);
        }

        // Set up the handler for this response
        handleOpenAIResponse(ws, input, previousResponseId, true);

        // Send the initial request
        const body: Record<string, unknown> = {
          type: 'response.create',
          model: MODEL,
          instructions: SYSTEM_PROMPT,
          tools: toolDefinitions,
          input,
        };
        if (previousResponseId) {
          body.previous_response_id = previousResponseId;
        }

        console.log('[ws] Sending request to OpenAI');
        ws.send(JSON.stringify(body));
      } catch (err) {
        console.error('[ws] Error in message handler:', err);
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
