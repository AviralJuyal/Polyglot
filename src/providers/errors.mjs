export class ProviderError extends Error {
  constructor(kind, provider, message, options = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.provider = provider;
    this.retryable = kind === 'rate_limit' || kind === 'server_error';
    this.retryAfterMs = options.retryAfterMs;
    this.raw = options.raw; // Server logs only. Never serialize this to a browser.
  }
}

export function normalizeHttpError(provider, status, raw, retryAfterHeader) {
  const detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const lower = detail.toLowerCase();
  let kind = 'bad_request';
  if (status === 401 || status === 403) kind = 'auth';
  else if (status === 429) kind = 'rate_limit';
  else if (status === 408 || status === 504) kind = 'timeout';
  else if (status >= 500) kind = 'server_error';
  else if (/context|token limit|too many tokens|maximum.*length/.test(lower)) kind = 'context_length';
  else if (/safety|content.filter|blocked|policy/.test(lower)) kind = 'content_filter';
  const retryAfterMs = Number.isFinite(Number(retryAfterHeader)) ? Number(retryAfterHeader) * 1000 : undefined;
  return new ProviderError(kind, provider, `${provider} request failed (${kind})`, { raw, retryAfterMs });
}

export function normalizeThrown(provider, error, signal) {
  if (error instanceof ProviderError) return error;
  if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return new ProviderError('timeout', provider, `${provider} request was cancelled or timed out`, { raw: error });
  }
  return new ProviderError('server_error', provider, `${provider} connection failed`, { raw: error });
}

export function safeError(error) {
  if (error instanceof ProviderError) return { kind: error.kind, provider: error.provider, message: error.message };
  return { kind: 'server_error', message: 'Request failed' };
}
