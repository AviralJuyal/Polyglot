# AI Usage

OpenAI Codex helped plan and implement the application, including the provider adapters, tenant storage, streaming chat, retrieval, browser UI, tests, and documentation. The mocked HTTP tests and local browser flow were exercised during development.

I corrected generated work where it failed concrete checks. An initial metrics INSERT had one placeholder too many; the chat integration test exposed it and I fixed the statement. A Gemini stream fixture exposed that a `[DONE]` sentinel should be ignored defensively. I also added preservation of Gemini function-call thought signatures after checking the provider documentation, and tightened the cost summary so fallback calls are charged at each model's own configured price.

I used the provider's official documentation to check request fields, stream events, and current pricing rather than treating generated API mappings as authoritative. No AI-generated claim of live-provider verification is included; those checks remain pending until API keys are supplied in the local environment.
