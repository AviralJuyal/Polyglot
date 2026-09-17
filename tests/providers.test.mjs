import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider as anthropic, toAnthropicMessages } from '../src/providers/adapters/anthropic.mjs';
import { createProvider as gemini, toGeminiContents } from '../src/providers/adapters/gemini.mjs';
import { createProvider as openai, toOpenAIMessages } from '../src/providers/adapters/openai.mjs';
import { costUsd } from '../src/config.mjs';

const textMessage = { role: 'user', content: [{ type: 'text', text: 'hello' }] };
const tool = { name: 'calculator', description: 'Calculate', parameters: { type: 'object', properties: {
  expression: { type: 'string' } }, required: ['expression'] } };

function streamResponse(frames) {
  const source = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(source, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function events(provider, model) {
  const result = [];
  for await (const event of provider.stream({ model, system: 'Be concise', messages: [textMessage], tools: [tool] })) result.push(event);
  return result;
}

test('OpenAI adapter maps system and accumulates fragmented tool arguments', async () => {
  let sent;
  const provider = openai({ name: 'openai', apiKey: 'test', fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return streamResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'calculator', arguments: '{"expression":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"2+3"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } }
    ]);
  } });
  const result = await events(provider, 'openai:gpt-4.1-mini');
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(sent.tools[0].function.name, 'calculator');
  assert.equal(result.find(event => event.type === 'tool_use_complete').input.expression, '2+3');
  assert.equal(result.find(event => event.type === 'usage').usage.cachedInputTokens, 2);
  assert.equal(result.at(-1).finishReason, 'tool_use');
});

test('Anthropic adapter keeps system separate and combines JSON deltas', async () => {
  let sent;
  const provider = anthropic({ name: 'anthropic', apiKey: 'test', fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return streamResponse([
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1,
        cache_read_input_tokens: 3, cache_creation_input_tokens: 5,
        cache_creation: { ephemeral_1h_input_tokens: 2, ephemeral_5m_input_tokens: 3 } } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'calculator' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"expression":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"8/2"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } }
    ]);
  } });
  const result = await events(provider, 'anthropic:claude-haiku-4-5-20251001');
  assert.equal(sent.system, 'Be concise');
  assert.equal(sent.messages[0].role, 'user');
  assert.equal(sent.tools[0].input_schema.type, 'object');
  assert.equal(result.find(event => event.type === 'tool_use_complete').input.expression, '8/2');
  const usage = result.find(event => event.type === 'usage').usage;
  assert.equal(usage.outputTokens, 6);
  assert.equal(usage.inputTokens, 18);
  assert.equal(usage.cachedInputTokens, 3);
  assert.equal(usage.cacheWriteTokens, 5);
  assert.equal(costUsd('anthropic:claude-haiku-4-5-20251001', usage), 48.05 / 1_000_000);
});

test('OpenAI adapter preserves image blocks in the portable message format', () => {
  const messages = toOpenAIMessages({ messages: [{ role: 'user', content: [
    { type: 'text', text: 'Describe this image' },
    { type: 'image', mimeType: 'image/png', data: 'AQID' },
    { type: 'text', text: 'Briefly' }
  ] }] });
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: 'Describe this image' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    { type: 'text', text: 'Briefly' }
  ]);
});

test('OpenAI tool deltas buffer arguments until a call ID arrives', async () => {
  const provider = openai({ name: 'openai', apiKey: 'test', fetchImpl: async () => streamResponse([
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"expression":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'late_id', function: {
      name: 'calculator', arguments: '"2+3"}' } }] }, finish_reason: 'tool_calls' }] }
  ]) });
  const result = await events(provider, 'openai:gpt-4.1-mini');
  assert.equal(result.find(event => event.type === 'tool_use_start').id, 'late_id');
  assert.equal(result.filter(event => event.type === 'tool_use_delta').map(event => event.partialJson).join(''),
    '{"expression":"2+3"}');
  assert.equal(result.find(event => event.type === 'tool_use_complete').input.expression, '2+3');
});

test('Gemini adapter maps roles and emits normalized tool events', async () => {
  let sent;
  const provider = gemini({ name: 'gemini', apiKey: 'test', fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return streamResponse([
      { candidates: [{ content: { parts: [{ functionCall: { id: 'fc_1', name: 'calculator', args: { expression: '7*4' } }, thoughtSignature: 'opaque-signature' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 1 } }
    ]);
  } });
  const result = await events(provider, 'gemini:gemini-2.5-flash');
  assert.equal(sent.systemInstruction.parts[0].text, 'Be concise');
  assert.equal(sent.contents[0].role, 'user');
  assert.equal(sent.generationConfig.thinkingConfig.thinkingBudget, 128);
  assert.equal(sent.tools[0].functionDeclarations[0].name, 'calculator');
  assert.equal(result.find(event => event.type === 'tool_use_complete').input.expression, '7*4');
  assert.equal(result.find(event => event.type === 'tool_use_complete').thoughtSignature, 'opaque-signature');
  assert.equal(result.find(event => event.type === 'usage').usage.reasoningTokens, 1);
  assert.equal(result.at(-1).finishReason, 'tool_use');
});

test('normalized conversation maps tool results to each vendor shape', () => {
  const request = { messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'calculator', input: { expression: '1+1' } }] },
    { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'x', name: 'calculator', content: '{"result":2}' }] }
  ] };
  assert.equal(toOpenAIMessages(request)[1].tool_call_id, 'x');
  assert.equal(toAnthropicMessages(request)[1].content[0].tool_use_id, 'x');
  assert.equal(toGeminiContents(request)[1].parts[0].functionResponse.name, 'calculator');
  const signed = toGeminiContents({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x',
    name: 'calculator', input: {}, thoughtSignature: 'opaque-signature' }] }] });
  assert.equal(signed[0].parts[0].thoughtSignature, 'opaque-signature');
});

test('embedding adapters return ordered vectors behind the same optional method', async () => {
  const open = openai({ name: 'openai', apiKey: 'test', fetchImpl: async () => new Response(JSON.stringify({ data: [
    { index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }
  ] }), { status: 200 }) });
  assert.deepEqual(await open.embed(['apple', 'banana'], 'text-embedding-3-small'), [[1, 0], [0, 1]]);
  const google = gemini({ name: 'gemini', apiKey: 'test', fetchImpl: async (_url, options) => {
    const value = JSON.parse(options.body).content.parts[0].text;
    return new Response(JSON.stringify({ embedding: { values: value === 'apple' ? [1, 0] : [0, 1] } }), { status: 200 });
  } });
  assert.deepEqual(await google.embed(['apple', 'banana'], 'gemini-embedding-001'), [[1, 0], [0, 1]]);
});

test('provider HTTP errors are normalized without exposing raw details', async () => {
  const provider = openai({ name: 'openai', apiKey: 'test', fetchImpl: async () => new Response(
    JSON.stringify({ error: { message: 'secret upstream detail' } }), { status: 429, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(() => provider.complete({ model: 'openai:gpt-4.1-mini', messages: [textMessage] }),
    error => error.kind === 'rate_limit' && error.retryable && !error.message.includes('secret upstream detail'));
});
