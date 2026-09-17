# AI Usage

OpenAI Codex helped plan and implement the application, including the provider adapters, tenant storage, streaming chat, retrieval, browser UI, tests, and documentation. The mocked HTTP tests and local browser flow were exercised during development.

Generated work was corrected where it failed concrete checks. An initial metrics INSERT had one placeholder too many; the chat integration test exposed it and the statement was fixed. A Gemini stream fixture exposed that a `[DONE]` sentinel should be ignored defensively. Provider documentation prompted preservation of Gemini function-call thought signatures and separate billing of its thinking tokens. The cost summary was also corrected so fallback calls use each model's own configured price. A browser smoke test found an empty chat placeholder and an empty error bubble; both were fixed.

I used the provider's official documentation to check request fields, stream events, and current pricing rather than treating generated API mappings as authoritative. No AI-generated claim of live-provider verification is included; those checks remain pending until API keys are supplied in the local environment.
