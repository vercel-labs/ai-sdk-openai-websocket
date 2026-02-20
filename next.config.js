/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['bash-tool', 'ws'],
  outputFileTracingIncludes: {
    '/api/chat': ['./content/docs/**/*'],
    '/api/chat-ws': ['./content/docs/**/*'],
  },
};

module.exports = nextConfig;
