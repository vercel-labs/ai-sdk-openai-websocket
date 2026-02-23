/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    'bash-tool',
    'ws',
    'bufferutil',
    'utf-8-validate',
    'ai-sdk-openai-websocket-fetch',
  ],
  outputFileTracingIncludes: {
    '/api/chat': ['./content/docs/**/*'],
    '/api/chat-ws': ['./content/docs/**/*'],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push('bufferutil', 'utf-8-validate');
    }
    return config;
  },
};

module.exports = nextConfig;
