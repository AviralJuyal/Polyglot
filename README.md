# Polyglot AI Workbench

Polyglot is a small web app for streaming chat across Anthropic, Gemini, and OpenAI. It also indexes tenant-owned documents for retrieval, supports three local tools, and records per-request latency, token use, and configured USD cost.

## Run locally

Requirements: **Node.js 26 or later** and **Python 3.9 or later**. No npm packages are required. Python's `pypdf` package is needed only for PDF uploads.

```bash
cp .env.example .env
python3 -m pip install -r requirements.txt
npm start
```

Open <http://127.0.0.1:3000>. The local demo accounts are `tenant-a` / `tenant-a-demo` and `tenant-b` / `tenant-b-demo`; change their passwords in `.env` if you expose the server beyond your machine. The server binds to loopback by default. Its local data lives under `data/` and is ignored by Git.

Add `GEMINI_API_KEY` and `OPENAI_API_KEY` to `.env` before live testing. Add `ANTHROPIC_API_KEY` if available. Restart the server after changing `.env`. Set `PYTHON_BIN` to a Python executable with `pypdf` installed if `python3` does not resolve to it. The sample `SESSION_SECRET` value causes the server to generate a private key in `data/session.key`; you may replace it with your own long random value.

Run the test suite with:

```bash
npm test
```

## What is implemented

| Area | Status |
| --- | --- |
| Provider abstraction | Three adapters, normalized messages/events/errors, configuration-driven model registry and pricing. Mocked HTTP tests pass. |
| Streaming chat | Browser SSE stream, SQLite persistence, provider/model switch between turns, upstream abort, conservative context-length rejection. |
| Document retrieval | PDF/TXT/Markdown ingestion, chunking, Gemini/OpenAI embedding adapters, cosine retrieval, inline citation markers and clickable source chunks, runtime retrieval settings and collection re-indexing. |
| Tool calling | Calculator, Open-Meteo weather, and document search; normalized tool definitions and a bounded multi-call loop. Adapter tool-stream mappings are fixture-tested. Live tool loops still need provider-key verification. |
| Metrics and resilience | Per-provider request metrics, cost from config, aggregate view, timeouts, selective retries with jitter, and a config-driven fallback chain. Fallback only occurs before visible stream output. |
| Tenant boundary | Signed demo session chooses a separate SQLite database per tenant. Conversations, files, chunks, citations, and usage records never share a database connection. |

**Live-key status:** Gemini, OpenAI, and Anthropic have not yet been verified against live API keys in this checkout. The adapter and orchestration tests use mocked HTTP streams. Anthropic has no live key available at the time of writing; its test fixtures exercise the documented request/response shape. Update this section after live smoke tests. PDF extraction has been tested locally with the `pypdf` helper.

## Known limits and scope cuts

- This is a local take-home app with two demo accounts, not production authentication. The demo credentials are published for reviewers; a real deployment needs an identity provider and stronger session controls.
- Citations are requested from the model and only known markers become clickable. The app exposes retrieved chunks, but it does not automatically verify that every factual sentence is supported by its citation.
- The vector store is an exact cosine scan over tenant-local chunks, capped by upload and chunk limits. It is intentionally sized for a take-home, not large collections.
- PDF extraction handles selectable text; scanned PDFs need OCR, which is outside this scope.
- Cost covers model completions. Embedding, weather, and infrastructure costs are not included in the spend panel.
- A failed stream after visible output is surfaced as an interrupted answer; the app does not splice a fallback model into an already-started response.
- Optional extras from the assignment are not implemented.

## Adding a fourth provider

Create `src/providers/adapters/<name>.mjs` exporting `createProvider({ name, apiKey })` with `complete`, `stream`, and optional `embed`, then add one provider object to `config/providers.json`. The registry dynamically imports the adapter named in that entry. The chat, tool loop, UI catalog, and metrics layer need no change. Add mocked tests for the new adapter's request mapping, stream events, errors, and usage.

## Repository map

- `src/providers/adapters/`: vendor-specific protocol conversion
- `src/providers/registry.mjs`: config-driven adapter discovery
- `src/chat.mjs`: streaming, tool loop, retry, and fallback orchestration
- `src/storage.mjs` and `src/session.mjs`: tenant databases and signed demo sessions
- `src/rag.mjs`: document extraction, chunking, embeddings, and retrieval
- `public/`: browser UI
- `tests/`: mocked HTTP and tenant-boundary tests
- `docs/DESIGN.md`: architecture, decisions, and security
- `docs/PROVIDER_NOTES.md`: concrete vendor differences and pricing sources
- `docs/AI_USAGE.md`: AI coding assistant disclosure
