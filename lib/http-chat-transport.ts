import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import type { ResponseStats } from './websocket-chat-transport';

export class HttpChatTransport implements ChatTransport<UIMessage> {
  private sessionId: string;
  onStatsUpdate?: (messageId: string, stats: ResponseStats) => void;

  constructor() {
    this.sessionId = Math.random().toString(36).substring(2, 15);
  }

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<UIMessage>['sendMessages']>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: this.sessionId, messages }),
      signal: abortSignal,
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const transport = this;

    return new ReadableStream({
      async start(controller) {
        let stats: ResponseStats | null = null;
        let buffer = '';

        function notifyStats() {
          if (transport.onStatsUpdate && stats) {
            transport.onStatsUpdate(stats.messageId, {
              ...stats,
              stepLatencies: [...stats.stepLatencies],
              stepResponseIds: [...stats.stepResponseIds],
              toolCallSteps: { ...stats.toolCallSteps },
            });
          }
        }

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim()) continue;

              const chunk = JSON.parse(line);

              // Handle data-stats — swallow, don't enqueue
              if (chunk.type === 'data-stats') {
                if (stats && chunk.data?.tokens) {
                  stats.tokens = chunk.data.tokens;
                  notifyStats();
                }
                continue;
              }

              // Track stats from standard chunk types
              switch (chunk.type) {
                case 'start':
                  stats = {
                    startTime: Date.now(),
                    steps: 0,
                    toolCalls: 0,
                    stepLatencies: [],
                    stepResponseIds: [],
                    currentStepStartTime: null,
                    endTime: null,
                    tokens: null,
                    toolCallSteps: {},
                    messageId: chunk.messageId ?? '',
                  };
                  notifyStats();
                  break;
                case 'start-step':
                  if (stats) {
                    stats.steps++;
                    stats.currentStepStartTime = Date.now();
                    if (chunk.responseId) {
                      stats.stepResponseIds.push(chunk.responseId);
                    }
                    notifyStats();
                  }
                  break;
                case 'tool-input-start':
                  if (stats) {
                    stats.toolCalls++;
                    stats.toolCallSteps[chunk.toolCallId] = stats.steps - 1;
                    notifyStats();
                  }
                  break;
                case 'finish-step':
                  if (stats && stats.currentStepStartTime) {
                    stats.stepLatencies.push(
                      Date.now() - stats.currentStepStartTime,
                    );
                    stats.currentStepStartTime = null;
                    notifyStats();
                  }
                  break;
                case 'finish':
                  if (stats) {
                    stats.endTime = Date.now();
                    notifyStats();
                  }
                  break;
              }

              controller.enqueue(chunk as UIMessageChunk);

              if (chunk.type === 'finish' || chunk.type === 'error') {
                controller.close();
                return;
              }
            }
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });
  }

  async reconnectToStream(): Promise<null> {
    return null;
  }
}
