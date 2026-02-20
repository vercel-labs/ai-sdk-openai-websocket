'use client';

import { useChat } from '@ai-sdk/react';
import { WebSocketChatTransport } from '@/lib/websocket-chat-transport';
import { useState } from 'react';

const transport = new WebSocketChatTransport({
  url:
    typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
      : 'ws://localhost:3000/ws',
});

function ToolCall({
  part,
}: {
  part: {
    type: string;
    toolName: string;
    toolCallId: string;
    state: string;
    input?: unknown;
    output?: unknown;
  };
}) {
  const [showInput, setShowInput] = useState(false);
  const [showOutput, setShowOutput] = useState(false);

  const input =
    part.input !== undefined
      ? typeof part.input === 'string'
        ? part.input
        : JSON.stringify(part.input, null, 2)
      : undefined;
  const output =
    part.output !== undefined
      ? typeof part.output === 'string'
        ? part.output
        : JSON.stringify(part.output, null, 2)
      : undefined;

  const stateLabel =
    part.state === 'input-streaming'
      ? 'streaming...'
      : part.state === 'input-available'
        ? 'executing...'
        : part.state === 'output-available'
          ? 'done'
          : part.state || '';

  const stateClass =
    part.state === 'input-streaming'
      ? 'streaming'
      : part.state === 'input-available'
        ? 'executing'
        : part.state === 'output-available'
          ? 'done'
          : '';

  return (
    <div className="tool-call">
      <div className="tool-call-header">
        <span className={`tool-call-indicator ${stateClass}`} />
        <span className="tool-call-name">{part.toolName}</span>
        <span className="tool-call-state">{stateLabel}</span>
      </div>

      {input !== undefined && (
        <div className="tool-call-section">
          <button
            className="tool-call-toggle"
            onClick={() => setShowInput(!showInput)}
          >
            {showInput ? '▾' : '▸'} Input
          </button>
          {showInput && <pre className="tool-call-content">{input}</pre>}
        </div>
      )}

      {output !== undefined && (
        <div className="tool-call-section">
          <button
            className="tool-call-toggle"
            onClick={() => setShowOutput(!showOutput)}
          >
            {showOutput ? '▾' : '▸'} Output
          </button>
          {showOutput && (
            <pre className="tool-call-content">
              {output.length > 2000
                ? output.substring(0, 2000) + '\n... (truncated)'
                : output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

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
              if (part.type === 'dynamic-tool') {
                return <ToolCall key={i} part={part} />;
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
