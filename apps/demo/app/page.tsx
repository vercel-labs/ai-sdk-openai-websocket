'use client';

import { useChat, type UIMessage } from '@ai-sdk/react';
import {
  HttpChatTransport,
  type ResponseStats,
} from '@/lib/http-chat-transport';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';

const wsTransport = new HttpChatTransport({ endpoint: '/api/chat-ws' });
const httpTransport = new HttpChatTransport({ endpoint: '/api/chat' });

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

const streamdownPlugins = { code };

type ToolPart = {
  type: 'dynamic-tool';
  toolName: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
};

function ToolSummary({
  parts,
  stats,
  hasText,
  isStreaming,
  expanded,
  onToggle,
}: {
  parts: ToolPart[];
  stats?: ResponseStats;
  hasText: boolean;
  isStreaming: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const activePart = [...parts].reverse().find(
    p => p.state === 'input-streaming' || p.state === 'input-available',
  );
  const doneCount = parts.filter(p => p.state === 'output-available').length;

  let label: string;
  if (hasText && isStreaming) {
    label = 'Rendering output';
  } else if (activePart) {
    const verb = activePart.state === 'input-streaming' ? 'calling' : 'running';
    label = `${verb} ${activePart.toolName}`;
    if (doneCount > 0) label += ` (${doneCount}/${parts.length} done)`;
  } else {
    label = `${doneCount} tool call${doneCount !== 1 ? 's' : ''} completed`;
  }

  const indicatorClass =
    hasText && isStreaming
      ? 'streaming'
      : activePart && !hasText
        ? 'executing'
        : 'done';

  return (
    <div className="tool-summary">
      <span className={`tool-call-indicator ${indicatorClass}`} />
      <span className="tool-summary-label">{label}</span>
      <button className="summary-toggle-btn" onClick={onToggle}>
        {expanded ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

function AssistantMessage({
  message,
  stats,
  expanded,
  onToggle,
}: {
  message: UIMessage;
  stats?: ResponseStats;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isStreaming = !stats?.endTime;
  const toolParts = message.parts.filter(
    p => p.type === 'dynamic-tool',
  ) as unknown as ToolPart[];
  const hasTools = toolParts.length > 0;
  const hasText = message.parts.some(p => p.type === 'text' && p.text.length > 0);

  return (
    <div className="message assistant">
      {hasTools && (
        <ToolSummary
          parts={toolParts}
          stats={stats}
          hasText={hasText}
          isStreaming={isStreaming}
          expanded={expanded}
          onToggle={onToggle}
        />
      )}
      {expanded &&
        message.parts.map((part, i) => {
          if (part.type === 'dynamic-tool') {
            const elements: React.ReactNode[] = [];
            elements.push(<ToolCall key={i} part={part} />);
            if (stats) {
              const myStep = stats.toolCallSteps[part.toolCallId];
              if (myStep !== undefined) {
                const nextPart = message.parts[i + 1];
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
            return elements;
          }
          if (part.type === 'text') {
            return (
              <Streamdown key={i} plugins={streamdownPlugins} animated={isStreaming}>
                {part.text}
              </Streamdown>
            );
          }
          return null;
        })}
      {stats && <ResponseStatsBar stats={stats} />}
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

function formatDiff(diff: number, baseline: number | null) {
  const sign = diff > 0 ? '+' : '';
  const abs = `${sign}${(diff / 1000).toFixed(3)}s`;
  if (baseline != null && baseline !== 0) {
    const pct = (diff / baseline) * 100;
    return `${abs} (${sign}${pct.toFixed(0)}%)`;
  }
  return abs;
}

function LatencyComparison({
  httpStats,
  wsStats,
}: {
  httpStats: ResponseStats;
  wsStats: ResponseStats;
}) {
  const [showExplanation, setShowExplanation] = useState(false);

  const minSteps = Math.min(
    httpStats.stepTtfbs.length,
    wsStats.stepTtfbs.length,
  );

  const pairedHttp = httpStats.stepTtfbs.slice(0, minSteps);
  const pairedWs = wsStats.stepTtfbs.slice(0, minSteps);

  if (minSteps === 0) return null;

  const httpTtfbSum = pairedHttp.reduce((a, b) => a + b, 0);
  const wsTtfbSum = pairedWs.reduce((a, b) => a + b, 0);
  const totalDiff = wsTtfbSum - httpTtfbSum;

  const httpAvg = mean(pairedHttp);
  const wsAvg = mean(pairedWs);
  const httpMedian = median(pairedHttp);
  const wsMedian = median(pairedWs);

  const avgDiff = wsAvg - httpAvg;
  const medianDiff = wsMedian - httpMedian;

  const hasExcludedSteps = minSteps > 1;
  const exHttp = pairedHttp.slice(1);
  const exWs = pairedWs.slice(1);
  const exHttpAvg = hasExcludedSteps ? mean(exHttp) : 0;
  const exWsAvg = hasExcludedSteps ? mean(exWs) : 0;
  const exHttpMedian = hasExcludedSteps ? median(exHttp) : 0;
  const exWsMedian = hasExcludedSteps ? median(exWs) : 0;
  const exAvgDiff = exWsAvg - exHttpAvg;
  const exMedianDiff = exWsMedian - exHttpMedian;

  return (
    <div className="latency-comparison">
      <div className="latency-comparison-title">TTFB (Time to First Byte)</div>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>HTTP</th>
            <th>WebSocket</th>
            <th>WS Diff</th>
          </tr>
        </thead>
        <tbody>
          {pairedHttp.map((http, i) => {
            const ws = pairedWs[i];
            const diff = ws - http;
            return (
              <tr key={i}>
                <td>Step {i + 1}</td>
                <td>{(http / 1000).toFixed(3)}s</td>
                <td>{(ws / 1000).toFixed(3)}s</td>
                <td className={diff > 0 ? 'slower' : 'faster'}>
                  {formatDiff(diff, http)}
                </td>
              </tr>
            );
          })}
          <tr className="total-row">
            <td>Total</td>
            <td>{(httpTtfbSum / 1000).toFixed(3)}s</td>
            <td>{(wsTtfbSum / 1000).toFixed(3)}s</td>
            <td className={totalDiff > 0 ? 'slower' : 'faster'}>
              {formatDiff(totalDiff, httpTtfbSum)}
            </td>
          </tr>
          <tr className="summary-row">
            <td>Avg</td>
            <td>{(httpAvg / 1000).toFixed(3)}s</td>
            <td>{(wsAvg / 1000).toFixed(3)}s</td>
            <td className={avgDiff > 0 ? 'slower' : 'faster'}>
              {formatDiff(avgDiff, httpAvg)}
            </td>
          </tr>
          <tr className="summary-row">
            <td>Median</td>
            <td>{(httpMedian / 1000).toFixed(3)}s</td>
            <td>{(wsMedian / 1000).toFixed(3)}s</td>
            <td className={medianDiff > 0 ? 'slower' : 'faster'}>
              {formatDiff(medianDiff, httpMedian)}
            </td>
          </tr>
          {hasExcludedSteps && (
            <>
              <tr className="excluding-header-row">
                <td colSpan={4}>
                  <span>Excluding step 1</span>
                  <button
                    className="explain-toggle"
                    onClick={() => setShowExplanation(v => !v)}
                    aria-label="Why exclude step 1?"
                    title="Why exclude step 1?"
                  >?</button>
                </td>
              </tr>
              {showExplanation && (
                <tr className="explanation-row">
                  <td colSpan={4}>
                    Step 1 includes the WebSocket handshake (DNS + TCP + TLS + upgrade),
                    making it slower than HTTP. Excluding it shows the steady-state
                    advantage of reusing an open connection.
                  </td>
                </tr>
              )}
              <tr className="summary-row">
                <td>Avg</td>
                <td>{(exHttpAvg / 1000).toFixed(3)}s</td>
                <td>{(exWsAvg / 1000).toFixed(3)}s</td>
                <td className={exAvgDiff > 0 ? 'slower' : 'faster'}>
                  {formatDiff(exAvgDiff, exHttpAvg)}
                </td>
              </tr>
              <tr className="summary-row">
                <td>Median</td>
                <td>{(exHttpMedian / 1000).toFixed(3)}s</td>
                <td>{(exWsMedian / 1000).toFixed(3)}s</td>
                <td className={exMedianDiff > 0 ? 'slower' : 'faster'}>
                  {formatDiff(exMedianDiff, exHttpMedian)}
                </td>
              </tr>
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface Turn {
  user?: UIMessage;
  httpAssistant?: UIMessage;
  wsAssistant?: UIMessage;
}

function buildTurns(httpMessages: UIMessage[], wsMessages: UIMessage[]): Turn[] {
  const turns: Turn[] = [];
  const httpByRole = groupByRole(httpMessages);
  const wsByRole = groupByRole(wsMessages);
  const maxLen = Math.max(httpByRole.length, wsByRole.length);
  for (let i = 0; i < maxLen; i++) {
    const httpPair = httpByRole[i];
    const wsPair = wsByRole[i];
    turns.push({
      user: httpPair?.user ?? wsPair?.user,
      httpAssistant: httpPair?.assistant,
      wsAssistant: wsPair?.assistant,
    });
  }
  return turns;
}

function groupByRole(
  messages: UIMessage[],
): { user?: UIMessage; assistant?: UIMessage }[] {
  const pairs: { user?: UIMessage; assistant?: UIMessage }[] = [];
  let current: { user?: UIMessage; assistant?: UIMessage } = {};
  for (const m of messages) {
    if (m.role === 'user') {
      if (current.user || current.assistant) {
        pairs.push(current);
        current = {};
      }
      current.user = m;
    } else if (m.role === 'assistant') {
      current.assistant = m;
      pairs.push(current);
      current = {};
    }
  }
  if (current.user || current.assistant) {
    pairs.push(current);
  }
  return pairs;
}

const DEFAULT_PROMPT =
  'Read through all documentation files. Then create a new doc file at /workspace/docs/provider-comparison.mdx that compares every AI provider supported by the SDK. For each provider, include: supported models, configuration options, and a basic usage example.';

type DiffLine = { text: string; type: 'add' | 'remove' | 'context' };

function DiffBlock({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="sidebar-code sidebar-diff">
      {lines.map((line, i) => {
        const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
        const className =
          line.type === 'add'
            ? 'diff-add'
            : line.type === 'remove'
              ? 'diff-remove'
              : 'diff-context';
        return (
          <span key={i} className={className}>
            {prefix} {line.text}
          </span>
        );
      })}
    </pre>
  );
}

function Sidebar({ open, onClose, animate }: { open: boolean; onClose: () => void; animate: boolean }) {
  if (!open) return null;

  return (
    <div className={`sidebar-overlay${animate ? '' : ' no-animate'}`} onClick={onClose}>
      <aside className={`sidebar${animate ? '' : ' no-animate'}`} onClick={e => e.stopPropagation()}>
        <div className="sidebar-header">
          <h2>About this demo</h2>
          <button className="sidebar-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="sidebar-body">
          <section>
            <h3>What is this?</h3>
            <p>
              This demo compares OpenAI&rsquo;s <strong>HTTP</strong> and <strong>WebSocket</strong> streaming
              APIs side by side. When you submit a prompt, it runs against both transports simultaneously
              so you can compare their Time-to-First-Byte (TTFB) performance in real time.
            </p>
          </section>

          <section>
            <h3>The agent</h3>
            <p>
              The AI agent has access to a <strong>virtual file system</strong> pre-loaded with all of the{' '}
              <a href="https://ai-sdk.dev/" target="_blank" rel="noopener noreferrer">AI SDK</a> documentation
              as markdown files. It can read, search, and write files using
              bash-like tools (<code>bash</code>, <code>readFile</code>, <code>writeFile</code>).
            </p>
          </section>

          <section>
            <h3>Why WebSocket?</h3>
            <p>
              OpenAI&rsquo;s WebSocket API keeps a persistent connection open. The key benefits:
            </p>
            <ul>
              <li><strong>No per-request handshake</strong> &mdash; after the initial connection, subsequent requests skip TCP/TLS/HTTP negotiation entirely</li>
              <li><strong>Lower TTFB on multi-step tool calls</strong> &mdash; in agentic workflows with many tool calls, each step reuses the open connection</li>
              <li><strong>Reduced overhead</strong> &mdash; no HTTP headers on each request/response cycle</li>
            </ul>
            <p>
              The <strong>first request is slower</strong> for WebSocket because it must establish the
              connection (DNS + TCP + TLS + WebSocket upgrade). After that, subsequent steps are faster
              since the connection is already open.
            </p>
          </section>

          <section>
            <h3>Implementation</h3>
            <p>
              The standard HTTP route is in <a
                href="https://github.com/vercel-labs/ai-sdk-openai-websocket/blob/main/apps/demo/app/api/chat/route.ts"
                target="_blank"
                rel="noopener noreferrer"
              >app/api/chat/route.ts</a>.
              To use the WebSocket API instead, only a few lines change:
            </p>
            <DiffBlock lines={[
              { text: "import {", type: 'context' },
              { text: "  streamText,", type: 'context' },
              { text: "  type UIMessage,", type: 'context' },
              { text: "  convertToModelMessages,", type: 'context' },
              { text: "  stepCountIs,", type: 'context' },
              { text: "} from 'ai';", type: 'context' },
              { text: "import { openai } from '@ai-sdk/openai';", type: 'remove' },
              { text: "import { createOpenAI } from '@ai-sdk/openai';", type: 'add' },
              { text: "import { createWebSocketFetch }", type: 'add' },
              { text: "  from 'ai-sdk-openai-websocket-fetch';", type: 'add' },
              { text: "import {", type: 'context' },
              { text: "  MODEL_ID, MAX_STEPS,", type: 'context' },
              { text: "  SYSTEM_PROMPT, createTools,", type: 'context' },
              { text: "} from '@/lib/chat-api';", type: 'context' },
              { text: "", type: 'context' },
              { text: "export async function POST(req: Request) {", type: 'context' },
              { text: "  const { messages }: { messages: UIMessage[] }", type: 'context' },
              { text: "    = await req.json();", type: 'context' },
              { text: "", type: 'context' },
              { text: "  const wsFetch = createWebSocketFetch();", type: 'add' },
              { text: "  const openai = createOpenAI({ fetch: wsFetch });", type: 'add' },
              { text: "  const tools = await createTools();", type: 'context' },
              { text: "", type: 'context' },
              { text: "  const result = streamText({", type: 'context' },
              { text: "    model: openai(MODEL_ID),", type: 'context' },
              { text: "    system: SYSTEM_PROMPT,", type: 'context' },
              { text: "    messages: await convertToModelMessages(messages),", type: 'context' },
              { text: "    tools,", type: 'context' },
              { text: "    stopWhen: stepCountIs(MAX_STEPS),", type: 'context' },
              { text: "    onFinish: () => wsFetch.close(),", type: 'add' },
              { text: "  });", type: 'context' },
              { text: "", type: 'context' },
              { text: "  return result.toUIMessageStreamResponse();", type: 'context' },
              { text: "}", type: 'context' },
            ]} />
          </section>

          <section>
            <h3>Demo prompt</h3>
            <p>
              The input is pre-filled with a prompt that asks the agent to create a provider comparison
              doc. This triggers ~20 tool calls (reading and writing docs), giving a clear picture of
              how HTTP and WebSocket performance compare in agentic workflows.
            </p>
          </section>
        </div>
        <div className="sidebar-footer">
          <a
            href="https://github.com/vercel-labs/ai-sdk-openai-websocket"
            target="_blank"
            rel="noopener noreferrer"
          >View on GitHub</a>
        </div>
      </aside>
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
  const [inputValue, setInputValue] = useState(DEFAULT_PROMPT);

  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarAnimateRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  useEffect(() => {
    if (localStorage.getItem('sidebar-closed') !== '1') {
      setSidebarOpen(true);
    }
    requestAnimationFrame(() => {
      sidebarAnimateRef.current = true;
    });
  }, []);

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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      isAtBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    autoResize();
  }, [inputValue, autoResize]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [wsChat.messages, httpChat.messages]);

  const isReady = wsChat.status === 'ready' && httpChat.status === 'ready';
  const isBusy = !isReady;

  function toggleTurnExpanded(turnIndex: number) {
    setExpandedTurns(prev => {
      const next = new Set(prev);
      if (next.has(turnIndex)) next.delete(turnIndex);
      else next.add(turnIndex);
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inputValue.trim()) {
      wsChat.sendMessage({ text: inputValue });
      httpChat.sendMessage({ text: inputValue });
      setInputValue('');
    }
  }

  function handleStop() {
    wsChat.stop();
    httpChat.stop();
  }

  const turns = buildTurns(httpChat.messages, wsChat.messages);

  return (
    <div className="chat-container">
      <Sidebar open={sidebarOpen} animate={sidebarAnimateRef.current} onClose={() => {
        setSidebarOpen(false);
        localStorage.setItem('sidebar-closed', '1');
      }} />
      <div className="chat-scroll-area" ref={scrollRef}>
        <div className="column-labels">
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen(true)}
            aria-label="About this demo"
            title="About this demo"
          >?</button>
          <div className="column-label">HTTP</div>
          <div className="column-label">WebSocket</div>
        </div>
        {turns.map((turn, i) => {
          const httpStats = turn.httpAssistant
            ? httpStatsMap[turn.httpAssistant.id]
            : undefined;
          const wsStats = turn.wsAssistant
            ? wsStatsMap[turn.wsAssistant.id]
            : undefined;
          const expanded = expandedTurns.has(i);
          const toggle = () => toggleTurnExpanded(i);

          return (
            <div key={i} className="turn">
              {turn.user && (
                <div className="message user">
                  {turn.user.parts.map((p, j) =>
                    p.type === 'text' ? <span key={j}>{p.text}</span> : null,
                  )}
                </div>
              )}
              {(turn.httpAssistant || turn.wsAssistant) && (
                <div className="response-columns">
                  <div className="response-column">
                    {turn.httpAssistant && (
                      <AssistantMessage
                        message={turn.httpAssistant}
                        stats={httpStats}
                        expanded={expanded}
                        onToggle={toggle}
                      />
                    )}
                  </div>
                  <div className="response-column">
                    {turn.wsAssistant && (
                      <AssistantMessage
                        message={turn.wsAssistant}
                        stats={wsStats}
                        expanded={expanded}
                        onToggle={toggle}
                      />
                    )}
                  </div>
                </div>
              )}
              {httpStats && wsStats && (
                <LatencyComparison httpStats={httpStats} wsStats={wsStats} />
              )}
            </div>
          );
        })}
      </div>

      <div className="input-bar">
        {isBusy && (
          <div className="status">
            {(wsChat.status === 'submitted' ||
              httpChat.status === 'submitted') && <span>Thinking...</span>}
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
          <textarea
            ref={textareaRef}
            name="message"
            placeholder="Type a message..."
            disabled={!isReady}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            rows={1}
          />
          <button type="submit" disabled={!isReady}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
