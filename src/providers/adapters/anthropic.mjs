import { modelConfig } from '../../config.mjs';
import { ProviderError, normalizeThrown } from '../errors.mjs';
import { checkedResponse, parseSSE } from '../sse.mjs';
import { completeByStreaming } from '../registry.mjs';

export function toAnthropicMessages(request) {
  return request.messages.map(message => {
    const content = message.content.map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text || '' };
      if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input || {} };
      if (block.type === 'tool_result') return { type: 'tool_result', tool_use_id: block.toolUseId,
        content: block.content || '', is_error: Boolean(block.isError) };
      if (block.type === 'image') return { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } };
      return null;
    }).filter(Boolean);
    // Anthropic tool results must appear as a user turn, even though our internal role is tool.
    return { role: message.role === 'tool' ? 'user' : message.role, content };
  });
}

export function createProvider({ name, apiKey, fetchImpl = fetch }) {
  return {
    name,
    async complete(request) { return completeByStreaming(this, request); },
    async *stream(request) {
      if (!apiKey) throw new ProviderError('auth', name, `${name} API key is not configured`);
      const model = modelConfig(request.model);
      const body = { model: model.providerModelId, max_tokens: request.maxTokens || 1024,
        messages: toAnthropicMessages(request), stream: true };
      if (request.system) body.system = request.system;
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.tools?.length) body.tools = request.tools.map(tool => ({
        name: tool.name, description: tool.description, input_schema: tool.parameters
      }));
      let response;
      try {
        response = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: request.signal
        });
        await checkedResponse(name, response);
      } catch (error) { throw normalizeThrown(name, error, request.signal); }

      const calls = new Map();
      let usage = { inputTokens: 0, outputTokens: 0 };
      let finishReason = 'stop';
      try {
        for await (const frame of parseSSE(response.body)) {
          if (frame.data === '[DONE]') break;
          const packet = JSON.parse(frame.data);
          if (packet.type === 'error') throw new ProviderError('server_error', name, `${name} stream failed`, { raw: packet.error });
          if (packet.type === 'message_start') {
            const u = packet.message?.usage || {};
            const cachedInputTokens = u.cache_read_input_tokens || 0;
            const cacheWriteTokens = u.cache_creation_input_tokens || 0;
            // Anthropic reports uncached, cache-read, and cache-write input separately.
            usage = { inputTokens: (u.input_tokens || 0) + cachedInputTokens + cacheWriteTokens,
              outputTokens: u.output_tokens || 0, cachedInputTokens, cacheWriteTokens,
              cacheWrite1hTokens: u.cache_creation?.ephemeral_1h_input_tokens || 0 };
          }
          if (packet.type === 'content_block_start' && packet.content_block?.type === 'tool_use') {
            const block = packet.content_block;
            calls.set(packet.index, { id: block.id, name: block.name,
              json: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '' });
            yield { type: 'tool_use_start', id: block.id, name: block.name };
          }
          if (packet.type === 'content_block_delta') {
            if (packet.delta?.type === 'text_delta') yield { type: 'text_delta', text: packet.delta.text };
            if (packet.delta?.type === 'input_json_delta') {
              const call = calls.get(packet.index);
              if (call) {
                call.json += packet.delta.partial_json;
                yield { type: 'tool_use_delta', id: call.id, partialJson: packet.delta.partial_json };
              }
            }
          }
          if (packet.type === 'message_delta') {
            const u = packet.usage || {};
            usage.outputTokens = u.output_tokens ?? usage.outputTokens;
            finishReason = packet.delta?.stop_reason === 'tool_use' ? 'tool_use'
              : packet.delta?.stop_reason === 'max_tokens' ? 'max_tokens'
                : packet.delta?.stop_reason === 'refusal' ? 'content_filter' : 'stop';
          }
        }
        for (const call of calls.values()) {
          let input;
          try { input = JSON.parse(call.json || '{}'); } catch { throw new ProviderError('bad_request', name, 'Invalid streamed tool arguments'); }
          yield { type: 'tool_use_complete', id: call.id, name: call.name, input };
        }
        yield { type: 'usage', usage };
        yield { type: 'done', finishReason };
      } catch (error) { throw normalizeThrown(name, error, request.signal); }
    }
  };
}
