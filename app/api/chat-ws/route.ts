import {
  streamText,
  type UIMessage,
  convertToModelMessages,
  stepCountIs,
} from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createWebSocketFetch } from '@/lib/openai-websocket-fetch';
import {
  MODEL_ID,
  MAX_STEPS,
  SYSTEM_PROMPT,
  createTools,
} from '@/lib/chat-api';

export const maxDuration = 300;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  console.log(`[ws] Request with ${messages.length} messages`);

  const wsFetch = createWebSocketFetch();
  const openai = createOpenAI({ fetch: wsFetch });
  const tools = await createTools();

  const result = streamText({
    model: openai(MODEL_ID),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    onFinish: () => wsFetch.close(),
  });

  return result.toUIMessageStreamResponse();
}
