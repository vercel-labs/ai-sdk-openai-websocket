import { join } from 'node:path';
import { z } from 'zod';
import { dynamicTool } from 'ai';
import { createBashTool } from 'bash-tool';
import { loadDocsFromDisk } from './load-docs';

export const MODEL_ID = 'gpt-4.1-mini';
export const MAX_STEPS = 30;

export const SYSTEM_PROMPT = `You are an AI SDK documentation assistant. You have access to the AI SDK documentation in /workspace/docs/. Use your tools to explore the docs, answer questions, and create or modify documentation files.

Always start by exploring the available files to understand the structure before answering. Use bash commands like ls, find, and grep to explore, then read specific files for details.

When writing new documentation, follow the patterns and conventions you observe in the existing docs.`;

let bashToolsPromise: Promise<Record<string, any>> | null = null;

function loadBashTools(): Promise<Record<string, any>> {
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

function truncate(value: string, max = 10000): string {
  return value.length > max
    ? value.substring(0, max) + '\n... (truncated)'
    : value;
}

function toStr(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result);
}

export async function createTools() {
  const bashTools = await loadBashTools();

  return {
    bash: dynamicTool({
      description:
        'Execute a bash command in the workspace. Available commands: ls, cat, head, tail, find, grep, sed, echo, mkdir, cp, mv, rm, wc, sort, etc.',
      inputSchema: z.object({
        command: z.string().describe('The bash command to execute'),
      }),
      execute: async input => {
        const { command } = input as { command: string };
        console.log('[tool] bash:', command.substring(0, 200));
        return truncate(toStr(await bashTools.bash.execute({ command })));
      },
    }),
    readFile: dynamicTool({
      description: 'Read the contents of a file at the given path.',
      inputSchema: z.object({
        path: z.string().describe('Absolute file path'),
      }),
      execute: async input => {
        const { path } = input as { path: string };
        console.log('[tool] readFile:', path);
        return truncate(toStr(await bashTools.readFile.execute({ path })));
      },
    }),
    writeFile: dynamicTool({
      description:
        'Write content to a file, creating it and parent dirs if needed.',
      inputSchema: z.object({
        path: z.string().describe('Absolute file path'),
        content: z.string().describe('File content to write'),
      }),
      execute: async input => {
        const { path, content } = input as { path: string; content: string };
        console.log('[tool] writeFile:', path);
        return toStr(await bashTools.writeFile.execute({ path, content }));
      },
    }),
  };
}
