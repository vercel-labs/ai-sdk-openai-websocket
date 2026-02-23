import {
  streamText,
  type UIMessage,
  convertToModelMessages,
  stepCountIs,
} from 'ai';
import { openai } from '@ai-sdk/openai';
import {
  MODEL_ID,
  MAX_STEPS,
  SYSTEM_PROMPT,
  createTools,
} from '@/lib/chat-api';

export const maxDuration = 300;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  console.log(`[http] Request with ${messages.length} messages`);

  const tools = await createTools();

  const result = streamText({
    model: openai(MODEL_ID),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
  });

  return result.toUIMessageStreamResponse();
}
