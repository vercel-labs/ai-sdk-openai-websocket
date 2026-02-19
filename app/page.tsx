'use client';

import { useChat } from '@ai-sdk/react';
import { WebSocketChatTransport } from '@/lib/websocket-chat-transport';

const transport = new WebSocketChatTransport({
  url:
    typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
      : 'ws://localhost:3000/ws',
});

export default function Chat() {
  const { messages, sendMessage, status, stop, error } = useChat({
    transport,
  });

  return (
    <div className="chat-container">
      <div className="messages">
        {messages.map(m => (
          <div key={m.id} className={`message ${m.role}`}>
            {m.parts.map((part, i) => {
              if (part.type === 'text') {
                return <span key={i}>{part.text}</span>;
              }
              return null;
            })}
          </div>
        ))}
      </div>

      {(status === 'submitted' || status === 'streaming') && (
        <div className="status">
          {status === 'submitted' && <div>Thinking...</div>}
          <button className="stop-button" onClick={stop}>
            Stop
          </button>
        </div>
      )}

      {error && <div className="error">Error: {error.message}</div>}

      <form
        className="input-form"
        onSubmit={e => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem(
            'message',
          ) as HTMLInputElement;
          if (input.value.trim()) {
            sendMessage({ text: input.value });
            input.value = '';
          }
        }}
      >
        <input
          name="message"
          placeholder="Type a message..."
          disabled={status !== 'ready'}
        />
        <button type="submit" disabled={status !== 'ready'}>
          Send
        </button>
      </form>
    </div>
  );
}
