import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';

export interface ResponseStats {
  startTime: number;
  steps: number;
  toolCalls: number;
  stepLatencies: number[];
  stepResponseIds: string[];
  currentStepStartTime: number | null;
  endTime: number | null;
  tokens: { input: number; inputCached: number; output: number } | null;
  toolCallSteps: Record<string, number>;
  messageId: string;
}

export class WebSocketChatTransport implements ChatTransport<UIMessage> {
  private ws: WebSocket | null = null;
  private url: string;
  onStatsUpdate?: (messageId: string, stats: ResponseStats) => void;

  constructor({ url }: { url: string }) {
    this.url = url;
  }

  private ensureConnection(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.ws);
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.onopen = () => {
        this.ws = ws;
        resolve(ws);
      };
      ws.onerror = () => reject(new Error('WebSocket connection failed'));
      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = null;
        }
      };
    });
  }

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<UIMessage>['sendMessages']>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    const ws = await this.ensureConnection();
    const requestId = Math.random().toString(36).substring(2, 15);
    const transport = this;

    return new ReadableStream({
      start(controller) {
        let stats: ResponseStats | null = null;

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

        function onMessage(event: MessageEvent) {
          const data = JSON.parse(event.data);
          if (data.requestId !== requestId) return;

          const chunk = data.chunk;

          // Handle custom data-stats chunk — swallow, don't enqueue
          if (chunk.type === 'data-stats') {
            if (stats && chunk.data?.tokens) {
              stats.tokens = chunk.data.tokens;
              notifyStats();
            }
            return;
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
                stats.stepLatencies.push(Date.now() - stats.currentStepStartTime);
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
            cleanup();
            controller.close();
          }
        }

        function onAbort() {
          cleanup();
          controller.close();
        }

        function cleanup() {
          ws.removeEventListener('message', onMessage);
          abortSignal?.removeEventListener('abort', onAbort);
        }

        ws.addEventListener('message', onMessage);
        abortSignal?.addEventListener('abort', onAbort);

        ws.send(JSON.stringify({ requestId, messages }));
      },
    });
  }

  async reconnectToStream(): Promise<null> {
    return null;
  }
}
