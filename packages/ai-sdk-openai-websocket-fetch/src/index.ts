import WebSocket from 'ws';

export interface CreateWebSocketFetchOptions {
  /**
   * WebSocket endpoint URL.
   * @default 'wss://api.openai.com/v1/responses'
   */
  url?: string;
}

/**
 * Creates a `fetch` function that routes OpenAI Responses API streaming
 * requests through a persistent WebSocket connection instead of HTTP.
 *
 * Non-streaming requests and requests to other endpoints are passed
 * through to the standard `fetch`.
 *
 * The connection is created lazily on the first streaming request and
 * reused for subsequent requests with the same Authorization header, reducing
 * latency in multi-step tool-calling workflows.
 *
 * @example
 * ```ts
 * import { createOpenAI } from '@ai-sdk/openai';
 * import { createWebSocketFetch } from 'ai-sdk-openai-websocket-fetch';
 *
 * const wsFetch = createWebSocketFetch();
 * const openai = createOpenAI({ fetch: wsFetch });
 *
 * const result = streamText({
 *   model: openai('gpt-4.1-mini'),
 *   prompt: 'Hello!',
 *   onFinish: () => wsFetch.close(),
 * });
 * ```
 */
export function createWebSocketFetch(
  options?: CreateWebSocketFetchOptions,
) {
  const wsUrl = options?.url ?? 'wss://api.openai.com/v1/responses';

  interface Connection {
    socket: WebSocket;
    authorization: string;
    busy: boolean;
  }

  let cached: Connection | null = null;
  const connections = new Set<Connection>();

  function forget(connection: Connection) {
    connections.delete(connection);
    if (cached === connection) cached = null;
  }

  function closeConnection(connection: Connection) {
    forget(connection);
    if (connection.socket.readyState === WebSocket.CONNECTING) {
      connection.socket.terminate();
    } else if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.close();
    }
  }

  function getConnection(authorization: string): Promise<Connection> {
    if (
      cached?.socket.readyState === WebSocket.OPEN &&
      cached.authorization === authorization &&
      !cached.busy
    ) {
      // Reserve the socket before yielding to another caller.
      cached.busy = true;
      return Promise.resolve(cached);
    }

    if (cached && !cached.busy) closeConnection(cached);

    const socket = new WebSocket(wsUrl, {
      headers: {
        Authorization: authorization,
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
    });
    const connection = { socket, authorization, busy: true };
    connections.add(connection);
    cached = connection;

    // An in-flight handshake is owned by its caller, just like an open socket.
    return new Promise<Connection>((resolve, reject) => {
      socket.once('open', () => resolve(connection));

      socket.on('error', err => {
        forget(connection);
        reject(err);
      });

      socket.on('close', () => {
        forget(connection);
        reject(new Error('WebSocket closed before opening'));
      });
    });
  }

  async function websocketFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      input instanceof URL
        ? input.toString()
        : typeof input === 'string'
          ? input
          : input.url;

    if (init?.method !== 'POST' || !url.endsWith('/responses')) {
      return globalThis.fetch(input, init);
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(typeof init.body === 'string' ? init.body : '');
    } catch {
      return globalThis.fetch(input, init);
    }

    if (!body.stream) {
      return globalThis.fetch(input, init);
    }

    const headers = normalizeHeaders(init.headers);
    const authorization = headers['authorization'] ?? '';

    const state = await getConnection(authorization);
    const connection = state.socket;

    const { stream: _, ...requestBody } = body;
    const encoder = new TextEncoder();
    let cancelStream: (() => void) | undefined;

    const responseStream = new ReadableStream<Uint8Array>({
      start(controller) {
        let finished = false;

        function cleanup(reusable = true) {
          if (finished) return false;
          finished = true;
          connection.off('message', onMessage);
          connection.off('error', onError);
          connection.off('close', onClose);
          init?.signal?.removeEventListener('abort', onAbort);
          state.busy = false;
          if (!reusable || cached !== state) closeConnection(state);
          return true;
        }

        function onMessage(data: WebSocket.RawData) {
          const text = data.toString();
          const lines = text.split(/\r?\n/);
          const sseData = lines.map(line => `data: ${line}`).join('\n');
          controller.enqueue(encoder.encode(`${sseData}\n\n`));

          try {
            const event = JSON.parse(text);
            if (
              event.type === 'response.completed' ||
              event.type === 'response.failed' ||
              event.type === 'response.incomplete' ||
              event.type === 'error'
            ) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              cleanup();
              controller.close();
            }
          } catch {
            // non-JSON frame, continue
          }
        }

        function onError(err: Error) {
          if (cleanup(false)) controller.error(err);
        }

        function onClose() {
          if (cleanup(false)) controller.close();
        }

        function onAbort() {
          if (!cleanup(false)) return;
          controller.error(
            init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'),
          );
        }

        cancelStream = () => {
          cleanup(false);
        };
        connection.on('message', onMessage);
        connection.on('error', onError);
        connection.on('close', onClose);

        if (init?.signal) {
          if (init.signal.aborted) {
            onAbort();
            return;
          }
          init.signal.addEventListener('abort', onAbort, { once: true });
        }

        try {
          connection.send(
            JSON.stringify({ type: 'response.create', ...requestBody }),
            err => {
              if (err) onError(err);
            },
          );
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      },
      cancel() {
        cancelStream?.();
      },
    });

    return new Response(responseStream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  return Object.assign(websocketFetch, {
    /** Close all underlying WebSocket connections, including pending ones. */
    close() {
      for (const connection of connections) closeConnection(connection);
    },
  });
}

function normalizeHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;

  if (headers instanceof Headers) {
    headers.forEach((v, k) => {
      result[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) {
      result[k.toLowerCase()] = v;
    }
  } else {
    for (const [k, v] of Object.entries(headers)) {
      if (v != null) result[k.toLowerCase()] = v;
    }
  }

  return result;
}
