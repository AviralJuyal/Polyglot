import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POLYGLOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polyglot-test-'));
const storage = await import('../src/storage.mjs');
const session = await import('../src/session.mjs');
const { chunkText, cosine, validateRetrievalSettings } = await import('../src/rag.mjs');
const { calculate } = await import('../src/tools.mjs');

test('tenant databases cannot read each other through ordinary queries', () => {
  const a = storage.tenantDb('tenant-a');
  const b = storage.tenantDb('tenant-b');
  const conversation = storage.createConversation(a, 'Tenant A secret');
  storage.addMessage(a, conversation.id, 'user', [{ type: 'text', text: 'private' }]);
  assert.equal(storage.listConversations(b).length, 0);
  assert.throws(() => storage.getConversation(b, conversation.id), { status: 404 });
  assert.equal(b.prepare('SELECT * FROM messages').all().length, 0);
});

test('signed session rejects a forged tenant id', () => {
  const cookie = session.sessionCookie('tenant-a').split(';')[0];
  assert.equal(session.tenantFromRequest({ headers: { cookie } }), 'tenant-a');
  const forged = cookie.replace('polyglot_session=', 'polyglot_session=x');
  assert.equal(session.tenantFromRequest({ headers: { cookie: forged } }), null);
});

test('safe calculator rejects code and handles precedence', () => {
  assert.equal(calculate('2 + 3 * (4 - 1)'), 11);
  assert.throws(() => calculate('process.exit()'));
  assert.throws(() => calculate('1/0'));
});

test('chunking overlaps and retrieval threshold validates input', () => {
  const chunks = chunkText('a '.repeat(500), 400, 80);
  assert.ok(chunks.length > 1);
  assert.ok(cosine([1, 0], [1, 0]) > 0.99);
  assert.throws(() => validateRetrievalSettings({ chunkSize: 400, overlap: 250 }));
});
