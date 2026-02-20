import {
  MODEL,
  MAX_STEPS,
  OPENAI_API_URL,
  SYSTEM_PROMPT,
  toolDefinitions,
  convertToOpenAIInput,
  getBashTools,
  executeFunctionCalls,
  type ClientMessage,
  type PendingToolCall,
} from '@/lib/chat-api';

export const maxDuration = 300;

export async function POST(request: Request) {
  const { messages } = (await request.json()) as { messages: ClientMessage[] };

  console.log(`[http] Request with ${messages.length} messages`);

  const bashTools = await getBashTools();
  const input = convertToOpenAIInput(messages);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  let cumulativeTokens = { input: 0, inputCached: 0, output: 0 };
  let stepCount = 0;
  let isFirstResponse = true;

  function send(chunk: Record<string, unknown>) {
    writer.write(encoder.encode(JSON.stringify(chunk) + '\n')).catch(() => {});
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
    const requestSentAt = Date.now();
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
          case 'response.created': {
            const ttfb = Date.now() - requestSentAt;
            if (isFirstResponse) {
              send({
                type: 'start',
                messageId: `msg-${event.response.id}`,
              });
              isFirstResponse = false;
            }
            send({ type: 'start-step', responseId: event.response.id, ttfb });
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

    const responseId = completedEvent.response.id;

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
      const toolOutputs = await executeFunctionCalls(
        functionCalls,
        bashTools,
        send,
      );
      send({ type: 'finish-step' });
      await runStep(toolOutputs, responseId);
    } else {
      send({ type: 'finish-step' });
      send({ type: 'finish', finishReason: 'stop' });
    }
  }

  (async () => {
    try {
      await runStep(input, null);
    } catch (err) {
      console.error('[http] Error:', err);
      send({
        type: 'error',
        errorText: err instanceof Error ? err.message : 'Internal error',
      });
    } finally {
      writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}
