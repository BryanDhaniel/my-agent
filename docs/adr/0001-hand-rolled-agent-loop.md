# Hand-rolled agent loop over agent frameworks

This project's goal is learning-first: understanding how coding agents actually work. We therefore call LLM provider SDKs directly (`@anthropic-ai/sdk`, `openai`) and implement the agentic tool-use loop ourselves, instead of building on Vercel AI SDK, Claude Agent SDK, Pydantic AI, or similar frameworks that own the loop.

## Considered Options

- **Agent framework (rejected)**: fastest path to a product, but hides exactly the machinery we set out to learn and adds lock-in.
- **Raw HTTP against provider APIs**: maximum protocol knowledge, but re-implementing SSE parsing/retries distracts from the loop, tools, and UI.

Direct official SDKs are the middle ground: they handle transport plumbing while we own messages, tools, permissions, sessions, and context management. Provider differences (tool-call shapes, event streams) are normalized behind our own `Provider` interface — adding a vendor means adding one file.

## Consequences

- We own the loop's correctness: retries, token accounting, and tool-result ordering are our responsibility.
- Adding a provider is deliberate work (one `Provider` implementation), not free.
