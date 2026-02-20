import WebSocket from 'ws';
import {
  MODEL,
  MAX_STEPS,
  OPENAI_WS_URL,
  SYSTEM_PROMPT,
  toolDefinitions,
  convertToOpenAIInput,
  getBashTools,
  executeFunctionCalls,
  type ClientMessage,
  type PendingToolCall,
} from '@/lib/chat-api';

export const maxDuration = 300;

interface StepResult {
  functionCalls: Array<{
    call_id: string;
    name: string;
    arguments: string;
  }>;
  responseId: string;
  usage: any;
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

function processStep(
  ws: WebSocket,
  input: unknown[],
  prevId: string | null,
  isFirstResponse: boolean,
  send: (chunk: Record<string, unknown>) => void,
  requestSentAt: number,
): Promise<{ result: StepResult; isFirstResponse: boolean }> {
  return new Promise((resolve, reject) => {
    let pendingToolCalls: PendingToolCall[] = [];
    let textPartId = '';
    let isFirstDelta = true;
    let firstResponse = isFirstResponse;

    function onMessage(rawMsg: WebSocket.RawData) {
      try {
        const event = JSON.parse(rawMsg.toString());

        switch (event.type) {
          case 'response.created': {
            const ttfb = Date.now() - requestSentAt;
            if (firstResponse) {
              send({
                type: 'start',
                messageId: `msg-${event.response.id}`,
              });
              firstResponse = false;
            }
            send({
              type: 'start-step',
              responseId: event.response.id,
              ttfb,
            });
            break;
          }

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

          case 'response.completed': {
            ws.off('message', onMessage);
            const functionCalls = (event.response.output || []).filter(
              (o: { type: string }) => o.type === 'function_call',
            );
            resolve({
              result: {
                functionCalls,
                responseId: event.response.id,
                usage: event.response.usage,
              },
              isFirstResponse: firstResponse,
            });
            break;
          }

          case 'error':
            ws.off('message', onMessage);
            reject(
              new Error(event.error?.message ?? 'Unknown OpenAI error'),
            );
            break;
        }
      } catch (err) {
        console.error('[openai] Error processing event:', err);
      }
    }

    ws.on('message', onMessage);

    const body: Record<string, unknown> = {
      type: 'response.create',
      model: MODEL,
      instructions: SYSTEM_PROMPT,
      tools: toolDefinitions,
      input,
    };
    if (prevId) {
      body.previous_response_id = prevId;
    }

    ws.send(JSON.stringify(body));
  });
}

export async function POST(request: Request) {
  const { messages } = (await request.json()) as { messages: ClientMessage[] };

  console.log(`[ws] Request with ${messages.length} messages`);

  const [ws, bashTools] = await Promise.all([
    connectToOpenAI(),
    getBashTools(),
  ]);

  const input = convertToOpenAIInput(messages);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  let cumulativeTokens = { input: 0, inputCached: 0, output: 0 };

  function send(chunk: Record<string, unknown>) {
    writer.write(encoder.encode(JSON.stringify(chunk) + '\n')).catch(() => {});
  }

  (async () => {
    try {
      let stepInput: unknown[] = input;
      let prevId: string | null = null;
      let stepCount = 0;
      let isFirstResponse = true;

      while (true) {
        const requestSentAt = Date.now();
        const { result, isFirstResponse: updatedFirst } = await processStep(
          ws,
          stepInput,
          prevId,
          isFirstResponse,
          send,
          requestSentAt,
        );
        isFirstResponse = updatedFirst;

        const usage = result.usage;
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

        prevId = result.responseId;

        if (result.functionCalls.length > 0 && stepCount < MAX_STEPS) {
          stepCount++;
          const toolOutputs = await executeFunctionCalls(
            result.functionCalls,
            bashTools,
            send,
          );
          send({ type: 'finish-step' });
          stepInput = toolOutputs;
        } else {
          send({ type: 'finish-step' });
          send({ type: 'finish', finishReason: 'stop' });
          break;
        }
      }
    } catch (err) {
      console.error('[ws] Error:', err);
      send({
        type: 'error',
        errorText: err instanceof Error ? err.message : 'Internal error',
      });
    } finally {
      writer.close().catch(() => {});
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}
