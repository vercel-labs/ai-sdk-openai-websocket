import './globals.css';
import 'streamdown/styles.css';

export const metadata = {
  title: 'AI SDK – OpenAI WebSocket vs HTTP Streaming',
  description:
    'Compare OpenAI\'s HTTP and WebSocket streaming APIs side by side. See how Time-to-First-Byte (TTFB) improves with persistent WebSocket connections in agentic workflows with many tool calls.',
  openGraph: {
    title: 'AI SDK – OpenAI WebSocket vs HTTP Streaming',
    description:
      'Compare OpenAI\'s HTTP and WebSocket streaming APIs side by side. See how TTFB improves with persistent WebSocket connections in agentic workflows.',
    images: [{ url: '/og.png' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AI SDK – OpenAI WebSocket vs HTTP Streaming',
    description:
      'Compare OpenAI\'s HTTP and WebSocket streaming APIs side by side. See how TTFB improves with persistent WebSocket connections in agentic workflows.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
