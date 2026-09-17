import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

// A tiny .env reader keeps the demo dependency-free. Real environment variables win.
export function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnv();
export const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/providers.json'), 'utf8'));

export function modelConfig(id) {
  for (const [provider, entry] of Object.entries(catalog.providers)) {
    if (entry.models?.[id]) return { provider, ...entry.models[id] };
  }
  throw new InputError(`Unknown model: ${id}`);
}

export function embeddingConfig(id) {
  for (const [provider, entry] of Object.entries(catalog.providers)) {
    if (entry.embeddingModels?.[id]) return { provider, ...entry.embeddingModels[id] };
  }
  throw new InputError(`Unknown embedding model: ${id}`);
}

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'InputError';
    this.status = status;
  }
}

export function publicCatalog() {
  const models = [];
  const embeddings = [];
  for (const [provider, entry] of Object.entries(catalog.providers)) {
    for (const [id, value] of Object.entries(entry.models || {})) {
      models.push({ id, provider, capabilities: value.capabilities, available: Boolean(process.env[entry.apiKeyEnv]) });
    }
    for (const id of Object.keys(entry.embeddingModels || {})) {
      embeddings.push({ id, provider, available: Boolean(process.env[entry.apiKeyEnv]) });
    }
  }
  return { models, embeddings, defaultModel: catalog.defaultModel, defaultEmbeddingModel: catalog.defaultEmbeddingModel };
}

export function costUsd(modelId, usage) {
  if (!usage) return null;
  const p = modelConfig(modelId).pricing;
  // The portable input count includes cache reads and writes. Anthropic reports
  // those separately upstream, so its adapter first combines all three buckets.
  const cacheWrite = usage.cacheWriteTokens || 0;
  const cacheWrite1h = Math.min(cacheWrite, usage.cacheWrite1hTokens || 0);
  const uncached = Math.max(0, usage.inputTokens - (usage.cachedInputTokens || 0) - cacheWrite);
  return (uncached * p.inputPerMTok + (usage.cachedInputTokens || 0) * (p.cachedInputPerMTok ?? p.inputPerMTok)
    + (cacheWrite - cacheWrite1h) * (p.cacheWrite5mPerMTok ?? p.inputPerMTok)
    + cacheWrite1h * (p.cacheWrite1hPerMTok ?? p.inputPerMTok)
    + usage.outputTokens * p.outputPerMTok
    // Gemini reports thought tokens separately from candidate output tokens. Other
    // providers include reasoning in outputTokens, so only a configured rate adds them.
    + (usage.reasoningTokens || 0) * (p.reasoningPerMTok || 0)) / 1_000_000;
}
