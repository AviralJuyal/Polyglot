import { modelConfig } from '../../config.mjs';
import { ProviderError, normalizeThrown } from '../errors.mjs';
import { checkedResponse, parseSSE } from '../sse.mjs';
import { completeByStreaming } from '../registry.mjs';

export function toOpenAIMessages(request) {
  const result = request.system ? [{ role: 'system', content: request.system }] : [];
  for (const message of request.messages) {
    const text = message.content.filter(block => block.type === 'text').map(block => block.text || '').join('\n');
    const calls = message.content.filter(block => block.type === 'tool_use');
    if (message.role === 'tool') {
      for (const block of message.content.filter(block => block.type === 'tool_result')) {
        result.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content || '' });
      }
    } else if (message.role === 'assistant' && calls.length) {
      result.push({ role: 'assistant', content: text || null, tool_calls: calls.map(block => ({
        id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
      })) });
    } else {
      result.push({ role: message.role, content: text });
    }
  }
  return result;
}

export function createProvider({ name, apiKey, fetchImpl = fetch }) {
  return {
    name,
    async complete(request) { return completeByStreaming(this, request); },
    async *stream(request) {
      if (!apiKey) throw new ProviderError('auth', name, `${name} API key is not configured`);
      const model = modelConfig(request.model);
      const body = {
        model: model.providerModelId,
        messages: toOpenAIMessages(request),
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: request.maxTokens || 1024
      };
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.tools?.length) body.tools = request.tools.map(tool => ({
        type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters }
      }));
      let response;
      try {
        response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: request.signal
        });
        await checkedResponse(name, response);
      } catch (error) { throw normalizeThrown(name, error, request.signal); }

      const calls = new Map();
      let finishReason = 'stop';
      try {
        for await (const frame of parseSSE(response.body)) {
          if (frame.data === '[DONE]') break;
          const packet = JSON.parse(frame.data);
          if (packet.error) throw new ProviderError('server_error', name, `${name} stream failed`, { raw: packet.error });
          if (packet.usage) yield { type: 'usage', usage: {
            inputTokens: packet.usage.prompt_tokens || 0,
            outputTokens: packet.usage.completion_tokens || 0,
            cachedInputTokens: packet.usage.prompt_tokens_details?.cached_tokens,
            reasoningTokens: packet.usage.completion_tokens_details?.reasoning_tokens
          } };
          const choice = packet.choices?.[0];
          if (!choice) continue;
          if (choice.delta?.content) yield { type: 'text_delta', text: choice.delta.content };
          for (const delta of choice.delta?.tool_calls || []) {
            const existing = calls.get(delta.index) || { id: '', name: '', json: '', started: false };
            if (delta.id) existing.id = delta.id;
            if (delta.function?.name) existing.name += delta.function.name;
            if (existing.id && existing.name && !existing.started) {
              existing.started = true;
              yield { type: 'tool_use_start', id: existing.id, name: existing.name };
            }
            if (delta.function?.arguments) {
              existing.json += delta.function.arguments;
              yield { type: 'tool_use_delta', id: existing.id, partialJson: delta.function.arguments };
            }
            calls.set(delta.index, existing);
          }
          if (choice.finish_reason) finishReason = choice.finish_reason === 'tool_calls' ? 'tool_use'
            : choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason === 'content_filter' ? 'content_filter' : 'stop';
        }
        for (const call of calls.values()) {
          let input;
          try { input = JSON.parse(call.json || '{}'); } catch { throw new ProviderError('bad_request', name, 'Invalid streamed tool arguments'); }
          yield { type: 'tool_use_complete', id: call.id, name: call.name, input };
        }
        yield { type: 'done', finishReason };
      } catch (error) { throw normalizeThrown(name, error, request.signal); }
    },
    async embed(texts, modelId, signal) {
      if (!apiKey) throw new ProviderError('auth', name, `${name} API key is not configured`);
      try {
        const response = await fetchImpl('https://api.openai.com/v1/embeddings', {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId, input: texts }), signal
        });
        await checkedResponse(name, response);
        const data = await response.json();
        return data.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
      } catch (error) { throw normalizeThrown(name, error, signal); }
    }
  };
}
