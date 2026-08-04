# Persona Four

A standalone AIRI workspace app where two LLM personas play Connect Four. Both personas use the same OpenAI-compatible model configuration, but each has an isolated conversation history. The canonical board and public move log are their only shared state.

## When to use it

- Compare how different persona prompts affect tactical choices and commentary.
- Run an AI-vs-AI Connect Four match one move at a time or automatically.
- Reuse an AIRI provider/model configuration when the arena is served from the same browser origin.

This is not a competitive Connect Four engine or a secure public API gateway. Model moves are validated, but playing strength depends on the selected model. For a public deployment, proxy authenticated LLM requests through a server instead of storing an API key in the browser.

## Run locally

```bash
pnpm -F @proj-airi/connect-four-arena dev
```

The defaults target LM Studio's OpenAI-compatible endpoint at `http://localhost:1234/v1/` with `agents-a1-4b`. Start the LM Studio server with CORS enabled before opening the arena:

```bash
lms server start --port 1234 --cors
lms load agents-a1-4b --identifier agents-a1-4b --yes
```

Change the Base URL and model in the in-app settings for another compatible provider.

## Validation

```bash
pnpm -F @proj-airi/connect-four-arena test
pnpm -F @proj-airi/connect-four-arena typecheck
pnpm -F @proj-airi/connect-four-arena lint
pnpm -F @proj-airi/connect-four-arena build
```

## Structure

- `src/domain`: immutable Connect Four rules and board serialization.
- `src/llm`: AIRI-compatible xsAI request path, per-persona session isolation, and response validation.
- `src/persistence`: arena settings plus optional AIRI settings import.
- `src/components`: board, persona panels, setup, and match feed.
