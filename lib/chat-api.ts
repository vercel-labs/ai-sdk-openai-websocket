import { join } from 'node:path';
import { createBashTool } from 'bash-tool';
import { loadDocsFromDisk } from './load-docs';

export const MODEL = 'gpt-4.1-mini';
export const MAX_STEPS = 30;
export const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
export const OPENAI_WS_URL = 'wss://api.openai.com/v1/responses';

export const SYSTEM_PROMPT = `You are an AI SDK documentation assistant. You have access to the Vercel AI SDK documentation in /workspace/docs/. Use your tools to explore the docs, answer questions, and create or modify documentation files.

Always start by exploring the available files to understand the structure before answering. Use bash commands like ls, find, and grep to explore, then read specific files for details.

When writing new documentation, follow the patterns and conventions you observe in the existing docs.`;

export const toolDefinitions = [
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

export interface MessagePart {
  type: string;
  text?: string;
}

export interface ClientMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
}

export interface PendingToolCall {
  call_id: string;
  name: string;
  arguments: string;
}

export function convertToOpenAIInput(messages: ClientMessage[]) {
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

// Cache bash tools at module level for warm instances
let bashToolsPromise: Promise<Record<string, any>> | null = null;

export function getBashTools(): Promise<Record<string, any>> {
  if (!bashToolsPromise) {
    bashToolsPromise = (async () => {
      const docsDir = join(process.cwd(), 'content', 'docs');
      const docsFiles = loadDocsFromDisk(docsDir);
      console.log(
        `Loaded ${Object.keys(docsFiles).length} doc files from ${docsDir}`,
      );
      const files: Record<string, string> = {};
      for (const [name, content] of Object.entries(docsFiles)) {
        files[`docs/${name}`] = content;
      }
      const { tools } = await createBashTool({ files });
      return tools;
    })();
  }
  return bashToolsPromise;
}

export async function executeFunctionCalls(
  functionCalls: Array<{
    call_id: string;
    name: string;
    arguments: string;
  }>,
  bashTools: Record<string, any>,
  send: (chunk: Record<string, unknown>) => void,
): Promise<Array<{ type: string; call_id: string; output: string }>> {
  const toolOutputs: Array<{ type: string; call_id: string; output: string }> =
    [];

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
        `[tool] Executing ${fc.name}:`,
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

  return toolOutputs;
}
