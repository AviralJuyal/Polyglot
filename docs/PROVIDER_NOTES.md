# Provider Notes

This file records differences handled by the adapters. Pricing below reflects the providers' public pages checked on 17 September 2026; `config/providers.json` is the editable source used by cost calculations.

| Concern | Anthropic | Gemini | OpenAI |
| --- | --- | --- | --- |
| System instruction | Top-level `system` field | `systemInstruction.parts` | A `system` chat message |
| User/assistant roles | `user` / `assistant` | `user` / `model` | `user` / `assistant` |
| Tool definition | `input_schema` | `functionDeclarations[].parameters` | `tools[].function.parameters` |
| Tool result | `tool_result` block in a user message | `functionResponse` part | `tool` message with `tool_call_id` |
| Stream shape | SSE message and content-block events | SSE `GenerateContentResponse` chunks | SSE chat completion deltas |
| Tool arguments | `input_json_delta.partial_json` fragments | `functionCall.args` commonly arrives as a complete object in `generateContent` streaming | `delta.tool_calls[].function.arguments` fragments |
| Usage | Separate uncached input, cache reads, cache writes, and output | `usageMetadata` with prompt, candidate, cached, and thought counts | Final usage chunk with prompt/completion and detail fields |

The normalized event stream uses `tool_use_start`, `tool_use_delta`, and `tool_use_complete` for all three. For Gemini, the adapter emits a single JSON delta from its complete function-call object. For Anthropic and OpenAI, the adapter accumulates fragments and parses JSON only after the stream completes. Gemini thought signatures on function-call parts are preserved in the internal tool-use block for continuation turns.

Anthropic's `input_tokens` excludes cache reads and writes. Its adapter adds all three buckets for the portable `inputTokens` total, then keeps cache reads and writes separate for cost and metrics. OpenAI's and Gemini's prompt counts already include their cached input. OpenAI tool-argument fragments are buffered until the stream supplies a call ID, so every normalized delta belongs to a named call. [Anthropic cache usage accounting](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Gemini 2.5 Flash's configured thinking budget is 128 tokens. Its output limit includes thinking tokens, so leaving dynamic thinking unlimited under a 768-token response cap could end a response before visible text appears. [Gemini thinking configuration](https://ai.google.dev/gemini-api/docs/generate-content/thinking).

Models and prices configured:

- Anthropic `claude-haiku-4-5-20251001`: $1 input / $5 output / $0.10 cache read / $1.25 five-minute cache write / $2 one-hour cache write per million tokens. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).
- Gemini `gemini-2.5-flash`: $0.30 text input / $2.50 output and thinking / $0.03 cached input per million tokens on the paid standard tier. Gemini reports thinking tokens separately, so the configured cost formula adds them to output billing. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [thinking token accounting](https://ai.google.dev/gemini-api/docs/generate-content/thinking).
- OpenAI `gpt-4.1-mini`: $0.40 input / $1.60 output / $0.10 cached input per million tokens. [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

Streaming references: [Anthropic Messages](https://platform.claude.com/docs/en/build-with-claude/streaming), [Gemini `streamGenerateContent`](https://ai.google.dev/api/generate-content), [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/create). Gemini's [thought-signature guidance](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures) is relevant when replaying tool turns through the REST API.

**Verification:** all three adapters have mocked HTTP tests covering request translation, streamed tool arguments, usage, and normalized failures. On 17 September 2026, Gemini and OpenAI also passed live streaming, conversation-switch, calculator, weather, and document-search checks. Both embedding adapters were exercised with a live document upload/re-index and cross-provider cited answers. Anthropic's fixture follows the documented SSE event format; it was not captured from a live Anthropic account. This distinction is stated in the README.
