### Example prompts

#### ~10 tool calls:

> "What are all the different ways to handle streaming in the AI SDK? Find every doc that mentions streaming, summarize the different approaches, and show example code for each."

This should trigger: ls → find/grep for streaming references → readFile on 5-7 matching docs → maybe a follow-up grep to find specific patterns.

#### ~20 tool calls:

> "Create a new doc file at /workspace/docs/provider-comparison.mdx that compares every AI provider supported by the SDK. For each provider, include: supported models, configuration
options, and a basic usage example. Base everything on what's already in the docs."

This should trigger: ls to explore structure → find for provider-related files → readFile on 10+ provider docs to extract details → grep for specific config patterns → writeFile for the
final output → possibly a readFile to verify.
