'use client';

import { useChat, type UIMessage } from '@ai-sdk/react';
import {
  WebSocketChatTransport,
  type ResponseStats,
} from '@/lib/websocket-chat-transport';
import { HttpChatTransport } from '@/lib/http-chat-transport';
import { useState, useEffect } from 'react';

const wsTransport = new WebSocketChatTransport({
  url:
    typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
      : 'ws://localhost:3000/ws',
});

const httpTransport = new HttpChatTransport();

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

function formatTokens(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function StepLatency({
  stats,
  stepIndex,
}: {
  stats: ResponseStats;
  stepIndex: number;
}) {
  const [, setTick] = useState(0);
  const latency = stats.stepLatencies[stepIndex];
  const isCurrentStep =
    latency === undefined &&
    stats.currentStepStartTime !== null &&
    stepIndex === stats.steps - 1;

  useEffect(() => {
    if (!isCurrentStep) return;
    const interval = setInterval(() => setTick(t => t + 1), 100);
    return () => clearInterval(interval);
  }, [isCurrentStep]);

  if (latency !== undefined) {
    return (
      <div className="step-latency">{(latency / 1000).toFixed(1)}s</div>
    );
  }
  if (isCurrentStep && stats.currentStepStartTime) {
    const elapsed = (Date.now() - stats.currentStepStartTime) / 1000;
    return <div className="step-latency">{elapsed.toFixed(1)}s…</div>;
  }
  return null;
}

function ResponseStatsBar({ stats }: { stats: ResponseStats }) {
  const isDone = stats.endTime !== null;
  if (!isDone || !stats.tokens) return null;

  const tokenStr =
    `${formatTokens(stats.tokens.input)} in` +
    (stats.tokens.inputCached > 0
      ? ` (${formatTokens(stats.tokens.inputCached)} cached)`
      : '') +
    ` → ${formatTokens(stats.tokens.output)} out`;

  return <div className="response-stats">Tokens: {tokenStr}</div>;
}

function MessageList({
  messages,
  statsMap,
}: {
  messages: UIMessage[];
  statsMap: Record<string, ResponseStats>;
}) {
  return (
    <div className="messages">
      {messages.map(m => {
        const stats = m.role === 'assistant' ? statsMap[m.id] : undefined;
        return (
          <div key={m.id} className={`message ${m.role}`}>
            {m.parts.map((part, i) => {
              const elements: React.ReactNode[] = [];

              if (part.type === 'text') {
                elements.push(<span key={i}>{part.text}</span>);
                if (stats) {
                  const textStepIndex = stats.steps - 1;
                  const hasToolCalls =
                    Object.keys(stats.toolCallSteps).length > 0;
                  if (hasToolCalls || stats.steps > 1) {
                    elements.push(
                      <StepLatency
                        key={`step-${textStepIndex}`}
                        stats={stats}
                        stepIndex={textStepIndex}
                      />,
                    );
                  }
                }
              } else if (part.type === 'dynamic-tool') {
                elements.push(<ToolCall key={i} part={part} />);
                if (stats) {
                  const myStep = stats.toolCallSteps[part.toolCallId];
                  if (myStep !== undefined) {
                    const nextPart = m.parts[i + 1];
                    const nextStep =
                      nextPart?.type === 'dynamic-tool'
                        ? stats.toolCallSteps[
                            (nextPart as { toolCallId: string }).toolCallId
                          ]
                        : undefined;
                    if (myStep !== nextStep) {
                      elements.push(
                        <StepLatency
                          key={`step-${myStep}`}
                          stats={stats}
                          stepIndex={myStep}
                        />,
                      );
                    }
                  }
                }
              }

              return elements;
            })}
            {stats && <ResponseStatsBar stats={stats} />}
          </div>
        );
      })}
    </div>
  );
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function LatencyComparison({
  wsStats,
  httpStats,
}: {
  wsStats: ResponseStats;
  httpStats: ResponseStats;
}) {
  const maxSteps = Math.max(
    wsStats.stepLatencies.length,
    httpStats.stepLatencies.length,
  );
  const wsTotal = wsStats.endTime! - wsStats.startTime;
  const httpTotal = httpStats.endTime! - httpStats.startTime;
  const totalDiff = httpTotal - wsTotal;

  const wsAvg =
    wsStats.stepLatencies.length > 0 ? mean(wsStats.stepLatencies) : null;
  const httpAvg =
    httpStats.stepLatencies.length > 0 ? mean(httpStats.stepLatencies) : null;
  const wsMedian =
    wsStats.stepLatencies.length > 0 ? median(wsStats.stepLatencies) : null;
  const httpMedian =
    httpStats.stepLatencies.length > 0 ? median(httpStats.stepLatencies) : null;

  const avgDiff =
    wsAvg != null && httpAvg != null ? httpAvg - wsAvg : null;
  const medianDiff =
    wsMedian != null && httpMedian != null ? httpMedian - wsMedian : null;

  return (
    <div className="latency-comparison">
      <table>
        <thead>
          <tr>
            <th></th>
            <th>WebSocket</th>
            <th>HTTP</th>
            <th>Diff</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: maxSteps }, (_, i) => {
            const ws = wsStats.stepLatencies[i];
            const http = httpStats.stepLatencies[i];
            const diff = ws != null && http != null ? http - ws : null;
            const wsRespId = wsStats.stepResponseIds[i];
            const httpRespId = httpStats.stepResponseIds[i];
            return (
              <tr key={i}>
                <td>
                  Step {i + 1}
                  {(wsRespId || httpRespId) && (
                    <div className="step-response-ids">
                      {wsRespId && <span title={wsRespId}>ws: {wsRespId}</span>}
                      {httpRespId && (
                        <span title={httpRespId}>http: {httpRespId}</span>
                      )}
                    </div>
                  )}
                </td>
                <td>{ws != null ? `${(ws / 1000).toFixed(1)}s` : '—'}</td>
                <td>
                  {http != null ? `${(http / 1000).toFixed(1)}s` : '—'}
                </td>
                <td
                  className={
                    diff != null ? (diff > 0 ? 'slower' : 'faster') : ''
                  }
                >
                  {diff != null
                    ? `${diff > 0 ? '+' : ''}${(diff / 1000).toFixed(1)}s`
                    : '—'}
                </td>
              </tr>
            );
          })}
          <tr className="total-row">
            <td>Total</td>
            <td>{(wsTotal / 1000).toFixed(1)}s</td>
            <td>{(httpTotal / 1000).toFixed(1)}s</td>
            <td className={totalDiff > 0 ? 'slower' : 'faster'}>
              {totalDiff > 0 ? '+' : ''}
              {(totalDiff / 1000).toFixed(1)}s
            </td>
          </tr>
          <tr className="summary-row">
            <td>Avg</td>
            <td>{wsAvg != null ? `${(wsAvg / 1000).toFixed(3)}s` : '—'}</td>
            <td>
              {httpAvg != null ? `${(httpAvg / 1000).toFixed(3)}s` : '—'}
            </td>
            <td
              className={
                avgDiff != null ? (avgDiff > 0 ? 'slower' : 'faster') : ''
              }
            >
              {avgDiff != null
                ? `${avgDiff > 0 ? '+' : ''}${(avgDiff / 1000).toFixed(3)}s`
                : '—'}
            </td>
          </tr>
          <tr className="summary-row">
            <td>Median</td>
            <td>
              {wsMedian != null ? `${(wsMedian / 1000).toFixed(3)}s` : '—'}
            </td>
            <td>
              {httpMedian != null
                ? `${(httpMedian / 1000).toFixed(3)}s`
                : '—'}
            </td>
            <td
              className={
                medianDiff != null
                  ? medianDiff > 0
                    ? 'slower'
                    : 'faster'
                  : ''
              }
            >
              {medianDiff != null
                ? `${medianDiff > 0 ? '+' : ''}${(medianDiff / 1000).toFixed(3)}s`
                : '—'}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default function Chat() {
  const wsChat = useChat({ transport: wsTransport, id: 'ws' });
  const httpChat = useChat({ transport: httpTransport, id: 'http' });

  const [wsStatsMap, setWsStatsMap] = useState<
    Record<string, ResponseStats>
  >({});
  const [httpStatsMap, setHttpStatsMap] = useState<
    Record<string, ResponseStats>
  >({});

  useEffect(() => {
    wsTransport.onStatsUpdate = (messageId, stats) => {
      setWsStatsMap(prev => ({ ...prev, [messageId]: stats }));
    };
    httpTransport.onStatsUpdate = (messageId, stats) => {
      setHttpStatsMap(prev => ({ ...prev, [messageId]: stats }));
    };
    return () => {
      wsTransport.onStatsUpdate = undefined;
      httpTransport.onStatsUpdate = undefined;
    };
  }, []);

  const isReady = wsChat.status === 'ready' && httpChat.status === 'ready';
  const isBusy = !isReady;

  // Find latest completed pair for comparison
  const wsAssistants = wsChat.messages.filter(m => m.role === 'assistant');
  const httpAssistants = httpChat.messages.filter(
    m => m.role === 'assistant',
  );
  const latestWsStats =
    wsAssistants.length > 0
      ? wsStatsMap[wsAssistants[wsAssistants.length - 1].id]
      : undefined;
  const latestHttpStats =
    httpAssistants.length > 0
      ? httpStatsMap[httpAssistants[httpAssistants.length - 1].id]
      : undefined;
  const showComparison =
    latestWsStats?.endTime != null && latestHttpStats?.endTime != null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const input = (e.currentTarget as HTMLFormElement).elements.namedItem(
      'message',
    ) as HTMLInputElement;
    if (input.value.trim()) {
      wsChat.sendMessage({ text: input.value });
      httpChat.sendMessage({ text: input.value });
      input.value = '';
    }
  }

  function handleStop() {
    wsChat.stop();
    httpChat.stop();
  }

  return (
    <div className="chat-container">
      <div className="chat-columns">
        <div className="chat-column">
          <div className="column-header">WebSocket</div>
          <MessageList messages={wsChat.messages} statsMap={wsStatsMap} />
        </div>
        <div className="chat-column">
          <div className="column-header">HTTP</div>
          <MessageList messages={httpChat.messages} statsMap={httpStatsMap} />
        </div>
      </div>

      {showComparison && (
        <LatencyComparison
          wsStats={latestWsStats!}
          httpStats={latestHttpStats!}
        />
      )}

      {isBusy && (
        <div className="status">
          {(wsChat.status === 'submitted' ||
            httpChat.status === 'submitted') && <div>Thinking...</div>}
          <button className="stop-button" onClick={handleStop}>
            Stop
          </button>
        </div>
      )}

      {(wsChat.error || httpChat.error) && (
        <div className="error">
          Error: {wsChat.error?.message || httpChat.error?.message}
        </div>
      )}

      <form className="input-form" onSubmit={handleSubmit}>
        <input
          name="message"
          placeholder="Type a message..."
          disabled={!isReady}
        />
        <button type="submit" disabled={!isReady}>
          Send
        </button>
      </form>
    </div>
  );
}
