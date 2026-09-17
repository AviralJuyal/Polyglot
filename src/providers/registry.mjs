import { catalog, embeddingConfig, InputError, modelConfig } from '../config.mjs';
import { assertProvider } from './contract.mjs';

const cache = new Map();

// The filename comes only from trusted configuration, never from an HTTP parameter.
// Adding a provider therefore means one adapter file and one catalog entry.
export async function getProvider(name) {
  const entry = catalog.providers[name];
  if (!entry || !/^[a-z0-9_-]+$/.test(entry.adapter)) throw new InputError('Unknown provider');
  if (!cache.has(name)) {
    const module = await import(`./adapters/${entry.adapter}.mjs`);
    cache.set(name, assertProvider(module.createProvider({ name, apiKey: process.env[entry.apiKeyEnv] || '' })));
  }
  return cache.get(name);
}

export async function providerForModel(modelId) {
  const config = modelConfig(modelId);
  return { provider: await getProvider(config.provider), config };
}

export async function providerForEmbedding(modelId) {
  const config = embeddingConfig(modelId);
  return { provider: await getProvider(config.provider), config };
}

export async function completeByStreaming(provider, request) {
  const content = [];
  let text = '';
  let usage = null;
  let finishReason = 'stop';
  for await (const event of provider.stream(request)) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'tool_use_complete') content.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input });
    if (event.type === 'usage') usage = event.usage;
    if (event.type === 'done') finishReason = event.finishReason;
    if (event.type === 'error') throw event.error;
  }
  if (text) content.unshift({ type: 'text', text });
  return { message: { role: 'assistant', content }, usage, finishReason };
}
