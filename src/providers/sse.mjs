// Providers use SSE but disagree about their JSON payloads. This parser only handles framing.
export async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const bytes of body) {
    pending += decoder.decode(bytes, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      const lines = frame.replace(/^\uFEFF/, '').split(/\r?\n/);
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || 'message';
      if (data) yield { event, data };
    }
  }
  pending += decoder.decode();
  if (pending.trim()) {
    const data = pending.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data) yield { event: 'message', data };
  }
}

export async function checkedResponse(provider, response) {
  if (response.ok) return response;
  let raw;
  try { raw = await response.json(); } catch { raw = await response.text().catch(() => ''); }
  const { normalizeHttpError } = await import('./errors.mjs');
  throw normalizeHttpError(provider, response.status, raw, response.headers.get('retry-after'));
}
