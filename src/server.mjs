import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { InputError, ROOT, embeddingConfig, publicCatalog } from './config.mjs';
import { authenticate, clearSessionCookie, sessionCookie, tenantFromRequest } from './session.mjs';
import { tenantDb, listConversations, getConversation, listCollections, createCollection,
  getCollection, listDocuments, getChunk, metrics } from './storage.mjs';
import { ingestDocument, reindexCollection, MAX_UPLOAD_BYTES, validateRetrievalSettings } from './rag.mjs';
import { browserError, runChat } from './chat.mjs';

const staticFiles = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']]
]);

function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...headers });
  res.end(data);
}

async function readBody(req, maxBytes = 32_000) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > maxBytes) throw new InputError('Request body is too large', 413);
    parts.push(part);
  }
  return Buffer.concat(parts);
}

async function readJson(req, maxBytes) {
  try { return JSON.parse((await readBody(req, maxBytes)).toString('utf8')); }
  catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('Invalid JSON body');
  }
}

function requireTenant(req) {
  const tenant = tenantFromRequest(req);
  if (!tenant) throw new InputError('Sign in to continue', 401);
  return { tenant, db: tenantDb(tenant) };
}

function checkOrigin(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (!origin) return;
  const expected = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  if (origin !== expected) throw new InputError('Invalid request origin', 403);
}

async function route(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  checkOrigin(req);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && staticFiles.has(url.pathname)) {
    const [file, type] = staticFiles.get(url.pathname);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(ROOT, file)).pipe(res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const { username, password } = await readJson(req);
    const tenant = authenticate(username, password);
    if (!tenant) throw new InputError('Invalid demo credentials', 401);
    tenantDb(tenant);
    json(res, 200, { tenant }, { 'Set-Cookie': sessionCookie(tenant) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    json(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/session') {
    json(res, 200, { tenant: tenantFromRequest(req) });
    return;
  }

  const { tenant, db } = requireTenant(req);
  if (req.method === 'GET' && url.pathname === '/api/catalog') {
    json(res, 200, publicCatalog()); return;
  }
  if (req.method === 'GET' && url.pathname === '/api/conversations') {
    json(res, 200, { conversations: listConversations(db) }); return;
  }
  const conversationPath = /^\/api\/conversations\/([a-f0-9-]+)$/.exec(url.pathname);
  if (req.method === 'GET' && conversationPath) {
    json(res, 200, getConversation(db, conversationPath[1])); return;
  }
  if (req.method === 'GET' && url.pathname === '/api/collections') {
    json(res, 200, { collections: listCollections(db) }); return;
  }
  if (req.method === 'POST' && url.pathname === '/api/collections') {
    const body = await readJson(req);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new InputError('Collection name must be 1–80 characters');
    embeddingConfig(body.embeddingModel);
    const settings = validateRetrievalSettings(body);
    json(res, 201, createCollection(db, { name: body.name.trim(), embeddingModel: body.embeddingModel,
      chunkSize: settings.chunkSize, overlap: settings.overlap }));
    return;
  }
  const documentsPath = /^\/api\/collections\/([a-f0-9-]+)\/documents$/.exec(url.pathname);
  if (req.method === 'GET' && documentsPath) {
    json(res, 200, { documents: listDocuments(db, documentsPath[1]) }); return;
  }
  if (req.method === 'POST' && documentsPath) {
    getCollection(db, documentsPath[1]);
    if (listDocuments(db, documentsPath[1]).length >= 20) throw new InputError('Collection is limited to 20 documents');
    let rawName;
    try { rawName = decodeURIComponent(String(req.headers['x-filename'] || '')); }
    catch { throw new InputError('Invalid filename'); }
    const filename = path.basename(rawName).replace(/[^a-zA-Z0-9_.() -]/g, '_').slice(0, 120);
    if (!filename) throw new InputError('Missing filename');
    const mime = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
    const buffer = await readBody(req, MAX_UPLOAD_BYTES);
    const result = await ingestDocument(db, documentsPath[1], buffer, filename, mime);
    json(res, 201, result); return;
  }
  const reindexPath = /^\/api\/collections\/([a-f0-9-]+)\/reindex$/.exec(url.pathname);
  if (req.method === 'POST' && reindexPath) {
    const body = await readJson(req);
    const settings = validateRetrievalSettings(body);
    const collection = getCollection(db, reindexPath[1]);
    const model = body.embeddingModel || collection.embedding_model;
    embeddingConfig(model);
    const result = await reindexCollection(db, reindexPath[1], settings, model);
    json(res, 200, result); return;
  }
  const chunkPath = /^\/api\/chunks\/([a-f0-9-]+)$/.exec(url.pathname);
  if (req.method === 'GET' && chunkPath) {
    const chunk = getChunk(db, chunkPath[1]);
    json(res, 200, { id: chunk.id, filename: chunk.filename, ordinal: chunk.ordinal, text: chunk.text });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/metrics') {
    const report = metrics(db);
    json(res, 200, { tenant, recent: report.recent.map(row => ({ tenant, ...row })), aggregate: report.aggregate }); return;
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const body = await readJson(req);
    if (body.collectionId) getCollection(db, body.collectionId);
    const retrieval = validateRetrievalSettings(body.retrieval || {});
    const controller = new AbortController();
    let completed = false;
    res.on('close', () => { if (!completed) controller.abort(new Error('Browser disconnected')); });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const emit = event => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    try {
      await runChat({ db, conversationId: body.conversationId || null, text: body.text,
        modelId: body.modelId, collectionId: body.collectionId || null,
        retrieval, enableTools: Boolean(body.enableTools), signal: controller.signal, emit });
    } catch (error) {
      if (!controller.signal.aborted) emit({ type: 'error', error: browserError(error) });
      else emit({ type: 'cancelled' });
      console.error('Chat error:', error.kind || error.message);
    } finally { completed = true; res.end(); }
    return;
  }
  throw new InputError('Not found', 404);
}

export function createServer() {
  return http.createServer((req, res) => {
    route(req, res).catch(error => {
      console.error('Request error:', error.kind || error.message);
      if (!res.headersSent) json(res, error.status || 500,
        { error: error instanceof InputError ? error.message : 'Internal server error' });
      else res.end();
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '127.0.0.1', () => console.log(`Polyglot: http://127.0.0.1:${port}`));
}
