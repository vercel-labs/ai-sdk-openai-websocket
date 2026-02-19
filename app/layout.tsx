import './globals.css';

export const metadata = {
  title: 'Next.js + AI SDK + OpenAI WebSocket Transport',
  description:
    'Chat using AI SDK with WebSocket transport to OpenAI Responses API.',
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
