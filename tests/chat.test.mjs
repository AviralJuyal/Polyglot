import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POLYGLOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polyglot-chat-test-'));
process.env.OPENAI_API_KEY = 'fixture-key';
process.env.GEMINI_API_KEY = 'fixture-key';
let handler;
globalThis.fetch = (...args) => handler(...args);
const { tenantDb, getConversation, metrics } = await import('../src/storage.mjs');
const { runChat } = await import('../src/chat.mjs');

function sse(frames) {
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 });
}

test('chat streams text, persists the conversation, and records cost', async () => {
  handler = async () => sse([
    { choices: [{ delta: { content: 'Hello ' } }] },
    { choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }
  ]);
  const db = tenantDb('tenant-a');
  const seen = [];
  await runChat({ db, text: 'hi', modelId: 'openai:gpt-4.1-mini', retrieval: { topK: 4, threshold: 0.35 },
    enableTools: false, emit: item => seen.push(item) });
  const id = seen.find(item => item.type === 'conversation').id;
  const saved = getConversation(db, id);
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.messages[1].content[0].text, 'Hello world');
  assert.equal(seen.filter(item => item.type === 'text_delta').map(item => item.text).join(''), 'Hello world');
  assert.ok(metrics(db).recent[0].cost_usd > 0);
});

test('failure before first token falls back to another configured provider', async () => {
  handler = async url => {
    if (String(url).includes('openai.com')) return new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 });
    return sse([{ candidates: [{ content: { parts: [{ text: 'Gemini answer' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 } }]);
  };
  const db = tenantDb('tenant-b');
  const seen = [];
  await runChat({ db, text: 'hello', modelId: 'openai:gpt-4.1-mini', retrieval: { topK: 4, threshold: 0.35 },
    enableTools: false, emit: item => seen.push(item) });
  assert.equal(seen.find(item => item.type === 'fallback').to, 'gemini:gemini-2.5-flash');
  assert.equal(seen.filter(item => item.type === 'text_delta').map(item => item.text).join(''), 'Gemini answer');
  assert.equal(metrics(db).recent.length, 2);
});

test('stop signal reaches the upstream request and prevents fallback after output', async () => {
  let upstreamSignal;
  handler = async (_url, options) => {
    upstreamSignal = options.signal;
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        upstreamSignal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      }
    }), { status: 200 });
  };
  const db = tenantDb('tenant-a');
  const controller = new AbortController();
  const seen = [];
  await assert.rejects(() => runChat({ db, text: 'stop me', modelId: 'openai:gpt-4.1-mini',
    retrieval: { topK: 4, threshold: 0.35 }, enableTools: false, signal: controller.signal,
    emit: item => { seen.push(item); if (item.type === 'text_delta') controller.abort(); } }));
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(seen.some(item => item.type === 'fallback'), false);
});

test('tool loop feeds two sequential results back to the model', async () => {
  const requests = [];
  handler = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (requests.length <= 2) {
      const id = `call_${requests.length}`;
      const expression = requests.length === 1 ? '2+2' : '4*3';
      return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id, function: {
          name: 'calculator', arguments: `{"expression":"${expression}"}` } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }
      ]);
    }
    return sse([
      { choices: [{ delta: { content: 'The results are 4 and 12.' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 18, completion_tokens: 8 } }
    ]);
  };
  const db = tenantDb('tenant-a');
  const seen = [];
  await runChat({ db, text: 'Calculate twice', modelId: 'openai:gpt-4.1-mini',
    retrieval: { topK: 4, threshold: 0.35 }, enableTools: true, emit: item => seen.push(item) });
  assert.equal(requests.length, 3);
  assert.equal(requests[1].messages.at(-1).role, 'tool');
  assert.equal(requests[2].messages.filter(message => message.role === 'tool').length, 2);
  assert.equal(seen.filter(item => item.type === 'tool_result').length, 2);
  assert.equal(seen.find(item => item.type === 'done').finishReason, 'stop');
});
