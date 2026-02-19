import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';

export class WebSocketChatTransport implements ChatTransport<UIMessage> {
  private ws: WebSocket | null = null;
  private url: string;

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

    return new ReadableStream({
      start(controller) {
        function onMessage(event: MessageEvent) {
          const data = JSON.parse(event.data);
          if (data.requestId !== requestId) return;

          const chunk = data.chunk as UIMessageChunk;
          controller.enqueue(chunk);

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
