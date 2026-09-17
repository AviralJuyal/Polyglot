import { modelConfig } from '../../config.mjs';
import { ProviderError, normalizeThrown } from '../errors.mjs';
import { checkedResponse, parseSSE } from '../sse.mjs';
import { completeByStreaming } from '../registry.mjs';

export function toGeminiContents(request) {
  return request.messages.map(message => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: message.content.map(block => {
      if (block.type === 'text') return { text: block.text || '' };
      if (block.type === 'tool_use') return { functionCall: { id: block.id, name: block.name, args: block.input || {} },
        ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}) };
      if (block.type === 'tool_result') return { functionResponse: { id: block.toolUseId,
        name: block.name, response: { result: block.content || '', isError: Boolean(block.isError) } } };
      if (block.type === 'image') return { inlineData: { mimeType: block.mimeType, data: block.data } };
      return null;
    }).filter(Boolean)
  }));
}

export function createProvider({ name, apiKey, fetchImpl = fetch }) {
  return {
    name,
    async complete(request) { return completeByStreaming(this, request); },
    async *stream(request) {
      if (!apiKey) throw new ProviderError('auth', name, `${name} API key is not configured`);
      const model = modelConfig(request.model);
      const body = { contents: toGeminiContents(request), generationConfig: { maxOutputTokens: request.maxTokens || 1024 } };
      // A bounded 2.5 Flash thinking budget leaves room for visible output under maxOutputTokens.
      if (model.thinkingBudget !== undefined) body.generationConfig.thinkingConfig = { thinkingBudget: model.thinkingBudget };
      if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
      if (request.temperature !== undefined) body.generationConfig.temperature = request.temperature;
      if (request.tools?.length) body.tools = [{ functionDeclarations: request.tools.map(tool => ({
        name: tool.name, description: tool.description, parameters: tool.parameters
      })) }];
      let response;
      try {
        response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.providerModelId)}:streamGenerateContent?alt=sse`, {
          method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: request.signal
        });
        await checkedResponse(name, response);
      } catch (error) { throw normalizeThrown(name, error, request.signal); }

      let usage = null;
      let finishReason = 'stop';
      let callIndex = 0;
      let sawCall = false;
      try {
        for await (const frame of parseSSE(response.body)) {
          if (frame.data === '[DONE]') break;
          const packet = JSON.parse(frame.data);
          if (packet.error) throw new ProviderError('server_error', name, `${name} stream failed`, { raw: packet.error });
          if (packet.usageMetadata) usage = { inputTokens: packet.usageMetadata.promptTokenCount || 0,
            outputTokens: packet.usageMetadata.candidatesTokenCount || 0,
            cachedInputTokens: packet.usageMetadata.cachedContentTokenCount,
            reasoningTokens: packet.usageMetadata.thoughtsTokenCount };
          const candidate = packet.candidates?.[0];
          for (const part of candidate?.content?.parts || []) {
            if (part.text && !part.thought) yield { type: 'text_delta', text: part.text };
            if (part.functionCall) {
              sawCall = true;
              const call = part.functionCall;
              const id = call.id || `gemini-call-${callIndex++}`;
              // generateContent returns a whole functionCall, so emit the same normalized stream sequence.
              yield { type: 'tool_use_start', id, name: call.name };
              yield { type: 'tool_use_delta', id, partialJson: JSON.stringify(call.args || {}) };
              yield { type: 'tool_use_complete', id, name: call.name, input: call.args || {},
                thoughtSignature: part.thoughtSignature };
            }
          }
          if (candidate?.finishReason === 'MAX_TOKENS') finishReason = 'max_tokens';
          if (candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'PROHIBITED_CONTENT') finishReason = 'content_filter';
        }
        if (sawCall) finishReason = 'tool_use';
        if (usage) yield { type: 'usage', usage };
        yield { type: 'done', finishReason };
      } catch (error) { throw normalizeThrown(name, error, request.signal); }
    },
    async embed(texts, modelId, signal) {
      if (!apiKey) throw new ProviderError('auth', name, `${name} API key is not configured`);
      const vectors = [];
      for (const text of texts) {
        try {
          const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:embedContent`, {
            method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: `models/${modelId}`, content: { parts: [{ text }] } }), signal
          });
          await checkedResponse(name, response);
          const data = await response.json();
          vectors.push(data.embedding.values);
        } catch (error) { throw normalizeThrown(name, error, signal); }
      }
      return vectors;
    }
  };
}
