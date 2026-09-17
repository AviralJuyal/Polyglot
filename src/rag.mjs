import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, InputError, embeddingConfig } from './config.mjs';
import { providerForEmbedding } from './providers/registry.mjs';
import { addDocumentWithChunks, collectionChunks, documentSources, getCollection, replaceCollectionIndex } from './storage.mjs';

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_CHARS = 60_000;
export const MAX_CHUNKS_PER_DOCUMENT = 50;

export function validateRetrievalSettings(value) {
  const chunkSize = Number(value.chunkSize ?? 1500);
  const overlap = Number(value.overlap ?? 200);
  const topK = Number(value.topK ?? 4);
  const threshold = Number(value.threshold ?? 0.35);
  if (!Number.isInteger(chunkSize) || chunkSize < 400 || chunkSize > 4000) throw new InputError('Chunk size must be 400–4000 characters');
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize / 2) throw new InputError('Overlap must be less than half the chunk size');
  if (!Number.isInteger(topK) || topK < 1 || topK > 10) throw new InputError('Top-k must be 1–10');
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new InputError('Threshold must be between 0 and 1');
  return { chunkSize, overlap, topK, threshold };
}

export function chunkText(source, size, overlap) {
  const text = source.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!text) return [];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      // Prefer a paragraph or sentence boundary; otherwise the sliding window is safe.
      const window = text.slice(start + Math.floor(size * 0.65), end);
      const paragraph = window.lastIndexOf('\n\n');
      const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
      const cut = paragraph >= 0 ? paragraph + 2 : sentence >= 0 ? sentence + 2 : -1;
      if (cut >= 0) end = start + Math.floor(size * 0.65) + cut;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end === text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return -1;
  let dot = 0, a2 = 0, b2 = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; a2 += a[i] ** 2; b2 += b[i] ** 2; }
  return a2 && b2 ? dot / Math.sqrt(a2 * b2) : -1;
}

async function extractPdf(buffer) {
  const command = process.env.PYTHON_BIN || 'python3';
  const script = path.join(ROOT, 'scripts/extract_pdf.py');
  return new Promise((resolve, reject) => {
    const child = spawn(command, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], errors = [];
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on('data', part => output.push(part));
    child.stderr.on('data', part => errors.push(part));
    child.on('error', () => { clearTimeout(timer); reject(new InputError('PDF extraction is unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new InputError(`Could not read PDF: ${Buffer.concat(errors).toString('utf8').slice(0, 150)}`));
      else resolve(Buffer.concat(output).toString('utf8'));
    });
    child.stdin.end(buffer);
  });
}

export async function extractText(buffer, filename, mime) {
  if (buffer.length > MAX_UPLOAD_BYTES) throw new InputError('File exceeds the 2 MB upload limit', 413);
  const ext = path.extname(filename).toLowerCase();
  let text;
  if (ext === '.pdf' && mime === 'application/pdf' && buffer.subarray(0, 5).toString() === '%PDF-') {
    text = await extractPdf(buffer);
  } else if ((ext === '.txt' || ext === '.md') && /^(text\/plain|text\/markdown|application\/octet-stream)$/.test(mime)) {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } else throw new InputError('Upload a PDF, TXT, or Markdown file with the matching content type');
  if (!text.trim()) throw new InputError('Document has no extractable text');
  if (text.length > MAX_TEXT_CHARS) throw new InputError('Extracted text exceeds the 60,000 character limit', 413);
  return text;
}

async function embedChunks(chunks, embeddingModel, signal) {
  const { provider, config } = await providerForEmbedding(embeddingModel);
  if (!provider.embed) throw new InputError('Selected provider does not support embeddings');
  // Batch where possible; Gemini adapter currently serializes calls to avoid rate bursts.
  const vectors = [];
  for (let i = 0; i < chunks.length; i += 16) {
    vectors.push(...await provider.embed(chunks.slice(i, i + 16), config.providerModelId, signal));
  }
  return vectors;
}

export async function ingestDocument(db, collectionId, buffer, filename, mime, signal) {
  const collection = getCollection(db, collectionId);
  const text = await extractText(buffer, filename, mime);
  const chunks = chunkText(text, collection.chunk_size, collection.overlap);
  if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) throw new InputError('Document creates too many chunks; increase chunk size or use a shorter file');
  const vectors = await embedChunks(chunks, collection.embedding_model, signal);
  return addDocumentWithChunks(db, collectionId, filename, mime, text, chunks, vectors);
}

export async function reindexCollection(db, collectionId, settings, embeddingModel, signal) {
  getCollection(db, collectionId);
  embeddingConfig(embeddingModel);
  const documents = documentSources(db, collectionId);
  const indexed = [];
  for (const document of documents) {
    const chunks = chunkText(document.source_text, settings.chunkSize, settings.overlap);
    if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) throw new InputError('New settings create too many chunks');
    indexed.push({ id: document.id, chunks, vectors: await embedChunks(chunks, embeddingModel, signal) });
  }
  replaceCollectionIndex(db, collectionId, { chunkSize: settings.chunkSize,
    overlap: settings.overlap, embeddingModel }, indexed);
  return { documents: documents.length, chunks: indexed.reduce((sum, value) => sum + value.chunks.length, 0) };
}

export async function retrieve(db, collectionId, query, options, signal) {
  const collection = getCollection(db, collectionId);
  const chunks = collectionChunks(db, collectionId);
  if (!chunks.length) return [];
  const [queryVector] = await embedChunks([query], collection.embedding_model, signal);
  return chunks.map(chunk => ({ id: chunk.id, filename: chunk.filename, ordinal: chunk.ordinal,
    text: chunk.text, score: cosine(queryVector, JSON.parse(chunk.embedding_json)) }))
    .filter(chunk => chunk.score >= options.threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.topK);
}
