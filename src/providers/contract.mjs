/**
 * The portable contract used by the entire app. Vendor shapes belong in adapters only.
 *
 * @typedef {{type:'text', text:string} | {type:'image', mimeType:string, data:string} |
 *   {type:'tool_use', id:string, name:string, input:object, thoughtSignature?:string} |
 *   {type:'tool_result', toolUseId:string, name?:string, content:string, isError?:boolean} |
 *   {type:'citation', label:string, chunkId:string, filename:string}} ContentBlock
 * @typedef {{role:'user'|'assistant'|'tool', content:ContentBlock[]}} Message
 * @typedef {{name:string, description:string, parameters:object}} ToolDefinition
 * @typedef {{model:string, messages:Message[], system?:string, tools?:ToolDefinition[],
 *   maxTokens?:number, temperature?:number, signal?:AbortSignal}} CompletionRequest
 * @typedef {{inputTokens:number, outputTokens:number, cachedInputTokens?:number, reasoningTokens?:number}} Usage
 * @typedef {{type:'text_delta', text:string} | {type:'tool_use_start', id:string, name:string} |
 *   {type:'tool_use_delta', id:string, partialJson:string} |
 *   {type:'tool_use_complete', id:string, name:string, input:object, thoughtSignature?:string} |
 *   {type:'usage', usage:Usage} | {type:'done', finishReason:string} |
 *   {type:'error', error:Error}} StreamEvent
 * @typedef {{name:string, complete:(request:CompletionRequest)=>Promise<object>,
 *   stream:(request:CompletionRequest)=>AsyncIterable<StreamEvent>,
 *   embed?:(texts:string[], model:string, signal?:AbortSignal)=>Promise<number[][]>}} Provider
 */

export function assertProvider(provider) {
  if (!provider || typeof provider.name !== 'string' || typeof provider.complete !== 'function'
      || typeof provider.stream !== 'function'
      || (provider.embed !== undefined && typeof provider.embed !== 'function')) {
    throw new TypeError('Adapter does not implement the Provider contract');
  }
  return provider;
}
