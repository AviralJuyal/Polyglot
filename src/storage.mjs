import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT, InputError } from './config.mjs';

const dataRoot = path.resolve(process.env.POLYGLOT_DATA_DIR || path.join(ROOT, 'data'));
const tenantRoot = path.join(dataRoot, 'tenants');
fs.mkdirSync(tenantRoot, { recursive: true, mode: 0o700 });
const open = new Map();

export function dataDirectory() { return dataRoot; }

export function tenantDb(tenant) {
  if (!/^[a-z0-9_-]{1,40}$/.test(tenant)) throw new InputError('Invalid tenant');
  if (open.has(tenant)) return open.get(tenant);
  // A tenant gets a physically separate database. A new SQL query on this connection
  // cannot read another tenant's rows, even if its author forgets a WHERE clause.
  const file = path.join(tenantRoot, `${createHash('sha256').update(tenant).digest('hex')}.sqlite`);
  const db = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content_json TEXT NOT NULL, model_id TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, embedding_model TEXT NOT NULL,
      chunk_size INTEGER NOT NULL, overlap INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, mime TEXT NOT NULL, char_count INTEGER NOT NULL,
      source_text TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, text TEXT NOT NULL, embedding_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chunks_collection ON chunks(collection_id);
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY, conversation_id TEXT, provider TEXT NOT NULL, model_id TEXT NOT NULL,
      created_at TEXT NOT NULL, ttft_ms INTEGER, latency_ms INTEGER NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER,
      cache_write_tokens INTEGER, cache_write_1h_tokens INTEGER,
      reasoning_tokens INTEGER, cost_usd REAL, finish_reason TEXT NOT NULL,
      retry_count INTEGER NOT NULL, fallback_used INTEGER NOT NULL, error_kind TEXT
    );
  `);
  if (!db.prepare('PRAGMA table_info(documents)').all().some(column => column.name === 'source_text')) {
    db.exec("ALTER TABLE documents ADD COLUMN source_text TEXT NOT NULL DEFAULT ''");
  }
  const usageColumns = new Set(db.prepare('PRAGMA table_info(usage_records)').all().map(column => column.name));
  if (!usageColumns.has('cache_write_tokens')) db.exec('ALTER TABLE usage_records ADD COLUMN cache_write_tokens INTEGER');
  if (!usageColumns.has('cache_write_1h_tokens')) db.exec('ALTER TABLE usage_records ADD COLUMN cache_write_1h_tokens INTEGER');
  // Early local databases appended source_text after created_at. A positional INSERT
  // briefly swapped those two values; recover rows we can identify unambiguously.
  const misplaced = db.prepare('SELECT id, source_text, created_at, char_count FROM documents').all()
    .filter(row => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.source_text)
      && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.created_at)
      && row.created_at.length === row.char_count);
  if (misplaced.length) {
    db.exec('BEGIN');
    try {
      const fix = db.prepare('UPDATE documents SET source_text = ?, created_at = ? WHERE id = ?');
      for (const row of misplaced) fix.run(row.created_at, row.source_text, row.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  open.set(tenant, db);
  return db;
}

export function listConversations(db) {
  return db.prepare('SELECT * FROM conversations ORDER BY created_at DESC').all();
}
export function createConversation(db, title) {
  const value = { id: randomUUID(), title: String(title).slice(0, 80) || 'New conversation', created_at: new Date().toISOString() };
  db.prepare('INSERT INTO conversations VALUES (?, ?, ?)').run(value.id, value.title, value.created_at);
  return value;
}
export function getConversation(db, id) {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!conversation) throw new InputError('Conversation not found', 404);
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid').all(id)
    .map(row => ({ ...row, content: JSON.parse(row.content_json) }));
  return { ...conversation, messages };
}
export function addMessage(db, conversationId, role, content, modelId = null) {
  if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) throw new InputError('Conversation not found', 404);
  const value = { id: randomUUID(), conversationId, role, content, modelId, createdAt: new Date().toISOString() };
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(value.id, value.conversationId,
    value.role, JSON.stringify(value.content), value.modelId, value.createdAt);
  return value;
}
export function listCollections(db) {
  return db.prepare(`SELECT c.*, COUNT(d.id) AS document_count FROM collections c
    LEFT JOIN documents d ON d.collection_id = c.id GROUP BY c.id ORDER BY c.created_at DESC`).all();
}
export function getCollection(db, id) {
  const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
  if (!row) throw new InputError('Collection not found', 404);
  return row;
}
export function createCollection(db, { name, embeddingModel, chunkSize, overlap }) {
  const value = { id: randomUUID(), name, embeddingModel, chunkSize, overlap, createdAt: new Date().toISOString() };
  db.prepare('INSERT INTO collections VALUES (?, ?, ?, ?, ?, ?)').run(value.id, value.name,
    value.embeddingModel, value.chunkSize, value.overlap, value.createdAt);
  return value;
}
export function addDocumentWithChunks(db, collectionId, filename, mime, text, chunks, vectors) {
  const id = randomUUID();
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO documents
      (id, collection_id, filename, mime, char_count, source_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, collectionId,
      filename, mime, text.length, text, new Date().toISOString());
    const insert = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)');
    chunks.forEach((chunk, index) => insert.run(randomUUID(), id, collectionId, index + 1, chunk, JSON.stringify(vectors[index])));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { id, collectionId, filename, mime, charCount: text.length, chunkCount: chunks.length };
}
export function listDocuments(db, collectionId) {
  getCollection(db, collectionId);
  return db.prepare('SELECT id, collection_id, filename, mime, char_count, created_at FROM documents WHERE collection_id = ? ORDER BY created_at DESC').all(collectionId);
}
export function documentSources(db, collectionId) {
  getCollection(db, collectionId);
  return db.prepare('SELECT id, source_text FROM documents WHERE collection_id = ?').all(collectionId);
}
export function replaceCollectionIndex(db, collectionId, { chunkSize, overlap, embeddingModel }, indexedDocuments) {
  getCollection(db, collectionId);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM chunks WHERE collection_id = ?').run(collectionId);
    db.prepare('UPDATE collections SET chunk_size = ?, overlap = ?, embedding_model = ? WHERE id = ?')
      .run(chunkSize, overlap, embeddingModel, collectionId);
    const insert = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)');
    for (const document of indexedDocuments) {
      document.chunks.forEach((chunk, index) => insert.run(randomUUID(), document.id,
        collectionId, index + 1, chunk, JSON.stringify(document.vectors[index])));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function collectionChunks(db, collectionId) {
  getCollection(db, collectionId);
  return db.prepare(`SELECT ch.*, d.filename FROM chunks ch JOIN documents d ON d.id = ch.document_id
    WHERE ch.collection_id = ? ORDER BY d.created_at, ch.ordinal`).all(collectionId);
}
export function getChunk(db, id) {
  const row = db.prepare(`SELECT ch.*, d.filename FROM chunks ch JOIN documents d ON d.id = ch.document_id WHERE ch.id = ?`).get(id);
  if (!row) throw new InputError('Chunk not found', 404);
  return row;
}
export function recordUsage(db, value) {
  // Name columns so migrations can add observability fields without changing old files' order.
  db.prepare(`INSERT INTO usage_records
    (id, conversation_id, provider, model_id, created_at, ttft_ms, latency_ms,
     input_tokens, output_tokens, cached_input_tokens, cache_write_tokens, cache_write_1h_tokens,
     reasoning_tokens, cost_usd, finish_reason, retry_count, fallback_used, error_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), value.conversationId || null, value.provider, value.modelId, new Date().toISOString(),
      value.ttftMs ?? null, value.latencyMs, value.usage?.inputTokens ?? null,
      value.usage?.outputTokens ?? null, value.usage?.cachedInputTokens ?? null,
      value.usage?.cacheWriteTokens ?? null, value.usage?.cacheWrite1hTokens ?? null,
      value.usage?.reasoningTokens ?? null, value.costUsd ?? null, value.finishReason,
      value.retryCount || 0, value.fallbackUsed ? 1 : 0, value.errorKind || null);
}
export function metrics(db) {
  const recent = db.prepare('SELECT * FROM usage_records ORDER BY created_at DESC LIMIT 100').all();
  const aggregate = db.prepare(`SELECT provider, COUNT(*) AS requests, SUM(cost_usd) AS total_spend_usd,
    AVG(latency_ms) AS avg_latency_ms FROM usage_records GROUP BY provider ORDER BY provider`).all();
  return { recent, aggregate };
}
