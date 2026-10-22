# ai-sdk-openai-websocket

> **Retired demo:** This project is no longer maintained. WebSocket support is now
> built into [AI SDK](https://ai-sdk.dev). Use AI SDK directly instead of this demo
> or the `ai-sdk-openai-websocket-fetch` and
> `@vercel/ai-sdk-openai-websocket-fetch` npm packages.

Monorepo containing:

- **[`ai-sdk-openai-websocket-fetch`](./packages/ai-sdk-openai-websocket-fetch/)** — Drop-in `fetch` replacement that routes OpenAI Responses API streaming requests through a persistent WebSocket connection. Published to npm.
- **[`demo`](./apps/demo/)** — Next.js app comparing HTTP vs WebSocket TTFB side by side. Deployed to Vercel.

## Development

```bash
pnpm install
pnpm dev
```

## Structure

```
├── packages/
│   └── ai-sdk-openai-websocket-fetch/   # npm package
├── apps/
│   └── demo/                            # Next.js demo app
└── .changeset/                          # changesets config
```

## Releasing

This repo uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing.

1. Run `pnpm changeset` to create a changeset
2. Merge to `main` — the GitHub Action opens a "Version Packages" PR
3. Merge that PR to publish to npm
