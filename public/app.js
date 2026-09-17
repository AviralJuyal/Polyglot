const $ = id => document.getElementById(id);
const state = { tenant: null, catalog: null, collections: [], conversationId: null,
  controller: null, matches: [], activeTab: 'chat' };

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function showNotice(message) {
  $('chat-notice').textContent = message;
  $('chat-notice').classList.toggle('hidden', !message);
}

function setTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach(panel => panel.classList.toggle('active', panel.id === `${tab}-panel`));
  if (tab === 'metrics') refreshMetrics().catch(error => showNotice(error.message));
}

function option(value, label) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}

function renderCatalog() {
  const models = $('model-select');
  models.replaceChildren(...state.catalog.models.map(item => option(item.id, `${item.id}${item.available ? '' : ' · key missing'}`)));
  models.value = state.catalog.defaultModel;
  const embeddings = $('embedding-select');
  embeddings.replaceChildren(...state.catalog.embeddings.map(item => option(item.id, `${item.id}${item.available ? '' : ' · key missing'}`)));
  embeddings.value = state.catalog.defaultEmbeddingModel;
}

async function refreshCollections() {
  state.collections = (await api('/api/collections')).collections;
  const chatSelect = $('collection-select');
  const selected = chatSelect.value;
  chatSelect.replaceChildren(option('', 'None'), ...state.collections.map(item => option(item.id, item.name)));
  if (state.collections.some(item => item.id === selected)) chatSelect.value = selected;
  const uploadSelect = $('upload-collection');
  const uploadSelected = uploadSelect.value;
  uploadSelect.replaceChildren(...state.collections.map(item => option(item.id, item.name)));
  if (state.collections.some(item => item.id === uploadSelected)) uploadSelect.value = uploadSelected;
  const list = $('collection-list');
  list.replaceChildren();
  if (!state.collections.length) list.textContent = 'No collections yet.';
  for (const collection of state.collections) {
    const row = document.createElement('div');
    row.className = 'collection-entry';
    const name = document.createElement('strong'); name.textContent = collection.name;
    const detail = document.createElement('small');
    detail.textContent = `${collection.document_count} documents · ${collection.embedding_model} · ${collection.chunk_size} character chunks`;
    row.append(name, detail);
    list.append(row);
  }
}

async function refreshConversations() {
  const conversations = (await api('/api/conversations')).conversations;
  const list = $('conversation-list');
  list.replaceChildren();
  for (const conversation of conversations) {
    const button = document.createElement('button');
    button.className = `conversation-item${state.conversationId === conversation.id ? ' active' : ''}`;
    button.textContent = conversation.title;
    button.title = conversation.title;
    button.onclick = () => loadConversation(conversation.id);
    list.append(button);
  }
}

function newConversation() {
  state.conversationId = null;
  state.matches = [];
  $('messages').replaceChildren();
  $('source-tray').replaceChildren();
  $('source-tray').classList.add('hidden');
  showNotice('');
  refreshConversations().catch(() => {});
}

function bubble(role, modelId = '') {
  const element = document.createElement('div');
  element.className = `message ${role}`;
  if (modelId) {
    const meta = document.createElement('div');
    meta.className = 'meta'; meta.textContent = modelId;
    element.append(meta);
  }
  const body = document.createElement('div');
  body.className = 'body';
  element.append(body);
  $('messages').append(element);
  $('messages').scrollTop = $('messages').scrollHeight;
  return { element, body };
}

function renderCitedText(container, text, citations) {
  container.replaceChildren();
  const byLabel = new Map(citations.map(item => [item.citation || item.label, item.chunkId]));
  const pattern = /\[(C\d+)\]/g;
  let last = 0, match;
  while ((match = pattern.exec(text))) {
    container.append(document.createTextNode(text.slice(last, match.index)));
    const chunkId = byLabel.get(match[1]);
    if (chunkId) {
      const button = document.createElement('button');
      button.className = 'citation'; button.textContent = `[${match[1]}]`;
      button.title = 'View retrieved chunk';
      button.onclick = () => showChunk(chunkId);
      container.append(button);
    } else container.append(document.createTextNode(match[0]));
    last = pattern.lastIndex;
  }
  container.append(document.createTextNode(text.slice(last)));
}

async function showChunk(id) {
  try {
    const chunk = await api(`/api/chunks/${id}`);
    $('chunk-title').textContent = `${chunk.filename} · chunk ${chunk.ordinal}`;
    $('chunk-text').textContent = chunk.text;
    $('chunk-dialog').showModal();
  } catch (error) { showNotice(error.message); }
}

function renderSources(matches) {
  const tray = $('source-tray');
  tray.replaceChildren();
  tray.classList.toggle('hidden', !matches.length);
  for (const item of matches) {
    const button = document.createElement('button');
    button.className = 'source-chip';
    button.textContent = `[${item.citation}] ${item.filename} · ${item.score.toFixed(2)}`;
    button.onclick = () => showChunk(item.chunkId);
    tray.append(button);
  }
}

async function loadConversation(id) {
  const conversation = await api(`/api/conversations/${id}`);
  state.conversationId = id;
  state.matches = [];
  $('messages').replaceChildren();
  renderSources([]);
  for (const message of conversation.messages) {
    if (message.role === 'tool') continue;
    const text = message.content.filter(block => block.type === 'text').map(block => block.text || '').join('\n');
    if (!text) continue;
    const view = bubble(message.role, message.model_id || '');
    const citations = message.content.filter(block => block.type === 'citation');
    renderCitedText(view.body, text, citations);
  }
  await refreshConversations();
  setTab('chat');
}

// Fetch supports a POST body and AbortController while still reading SSE frames as they arrive.
async function consumeSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data) onEvent(JSON.parse(data));
    }
  }
}

function busy(value) {
  $('send').disabled = value;
  $('prompt').disabled = value;
  $('stop').classList.toggle('hidden', !value);
}

async function sendChat(event) {
  event.preventDefault();
  const text = $('prompt').value.trim();
  if (!text || state.controller) return;
  showNotice('');
  $('prompt').value = '';
  bubble('user').body.textContent = text;
  const view = bubble('assistant', $('model-select').value);
  let answer = '';
  state.matches = [];
  renderSources([]);
  state.controller = new AbortController();
  busy(true);
  try {
    const response = await fetch('/api/chat', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, signal: state.controller.signal,
      body: JSON.stringify({ conversationId: state.conversationId, text, modelId: $('model-select').value,
        collectionId: $('collection-select').value || null, enableTools: $('tools-toggle').checked,
        retrieval: { topK: Number($('top-k')?.value || 4), threshold: Number($('threshold')?.value || 0.35) } }) });
    if (!response.ok) {
      const error = await response.json(); throw new Error(error.error || 'Chat request failed');
    }
    await consumeSSE(response, item => {
      if (item.type === 'conversation') { state.conversationId = item.id; refreshConversations().catch(() => {}); }
      if (item.type === 'retrieval') { state.matches = item.matches; renderSources(item.matches); }
      if (item.type === 'text_delta') { answer += item.text; view.body.textContent = answer; $('messages').scrollTop = $('messages').scrollHeight; }
      if (item.type === 'replace_text') { answer = item.text; view.body.textContent = answer; }
      if (item.type === 'notice') showNotice(item.message);
      if (item.type === 'fallback') { view.element.querySelector('.meta').textContent = item.to; showNotice(`Fallback: ${item.from} → ${item.to}`); }
      if (item.type === 'tool_use_start') showNotice(`Calling ${item.name}…`);
      if (item.type === 'tool_result') showNotice(`${item.name} ${item.isError ? 'failed' : 'completed'}.`);
      if (item.type === 'summary') {
        view.element.querySelector('.meta').textContent = `${item.modelId} · ${item.costUsd == null ? 'cost unavailable' : '$' + item.costUsd.toFixed(5)}`;
      }
      if (item.type === 'done') renderCitedText(view.body, answer, state.matches);
      if (item.type === 'error') showNotice(item.error.message);
      if (item.type === 'cancelled') showNotice('Upstream request cancelled.');
    });
  } catch (error) {
    showNotice(error.name === 'AbortError' ? 'Upstream request cancelled.' : error.message);
  } finally {
    state.controller = null; busy(false); $('prompt').focus();
    refreshConversations().catch(() => {});
  }
}

async function refreshMetrics() {
  const data = await api('/api/metrics');
  $('metrics-tenant').textContent = `Only ${data.tenant}'s requests are shown.`;
  const aggregate = $('aggregate');
  aggregate.replaceChildren();
  for (const item of data.aggregate) {
    const card = document.createElement('div'); card.className = 'metric-card';
    const label = document.createElement('span'); label.textContent = `${item.provider} · ${item.requests} requests`;
    const value = document.createElement('strong'); value.textContent = `$${(item.total_spend_usd || 0).toFixed(5)}`;
    const latency = document.createElement('span'); latency.textContent = `Avg latency ${Math.round(item.avg_latency_ms || 0)} ms`;
    card.append(label, value, latency); aggregate.append(card);
  }
  const rows = $('metrics-rows'); rows.replaceChildren();
  for (const record of data.recent) {
    const tr = document.createElement('tr');
    const values = [new Date(record.created_at).toLocaleString(), `${record.provider} / ${record.model_id}`,
      record.ttft_ms == null ? '—' : `${record.ttft_ms} ms`, `${record.latency_ms} ms`,
      `${record.input_tokens ?? '—'} / ${record.output_tokens ?? '—'}`,
      record.cost_usd == null ? '—' : `$${record.cost_usd.toFixed(5)}`, record.finish_reason,
      `${record.retry_count} / ${record.fallback_used ? 'yes' : 'no'}`];
    for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    rows.append(tr);
  }
}

async function initialize() {
  const session = await api('/api/session');
  state.tenant = session.tenant;
  $('login').classList.toggle('hidden', Boolean(state.tenant));
  $('app').classList.toggle('hidden', !state.tenant);
  if (!state.tenant) return;
  $('tenant-label').textContent = state.tenant;
  state.catalog = await api('/api/catalog');
  renderCatalog();
  await Promise.all([refreshCollections(), refreshConversations()]);
}

$('login-form').onsubmit = async event => {
  event.preventDefault(); $('login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('login-user').value, password: $('login-password').value }) });
    $('login-password').value = ''; await initialize();
  } catch (error) { $('login-error').textContent = error.message; }
};
$('logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); newConversation(); await initialize(); };
$('new-chat').onclick = newConversation;
document.querySelectorAll('.tab').forEach(button => button.onclick = () => setTab(button.dataset.tab));
$('chat-form').onsubmit = sendChat;
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('chat-form').requestSubmit(); } };
$('stop').onclick = () => state.controller?.abort();
$('collection-form').onsubmit = async event => {
  event.preventDefault();
  try {
    await api('/api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('collection-name').value, embeddingModel: $('embedding-select').value,
        chunkSize: Number($('chunk-size').value), overlap: Number($('overlap').value) }) });
    $('collection-name').value = ''; $('document-status').textContent = 'Collection created.';
    await refreshCollections();
  } catch (error) { $('document-status').textContent = error.message; }
};
$('upload-form').onsubmit = async event => {
  event.preventDefault();
  const file = $('upload-file').files[0];
  if (!file) return;
  $('document-status').textContent = 'Uploading, extracting, and embedding…';
  try {
    const mime = file.type || (file.name.endsWith('.md') ? 'text/markdown' : 'text/plain');
    const result = await api(`/api/collections/${$('upload-collection').value}/documents`, {
      method: 'POST', headers: { 'Content-Type': mime, 'X-Filename': encodeURIComponent(file.name) }, body: file });
    $('document-status').textContent = `Indexed ${result.filename} into ${result.chunkCount} chunks.`;
    $('upload-file').value = ''; await refreshCollections();
  } catch (error) { $('document-status').textContent = error.message; }
};
$('reindex').onclick = async () => {
  const id = $('upload-collection').value;
  if (!id) return;
  $('document-status').textContent = 'Re-indexing collection…';
  try {
    const result = await api(`/api/collections/${id}/reindex`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        chunkSize: Number($('chunk-size').value), overlap: Number($('overlap').value),
        embeddingModel: $('embedding-select').value }) });
    $('document-status').textContent = `Re-indexed ${result.documents} documents into ${result.chunks} chunks.`;
    await refreshCollections();
  } catch (error) { $('document-status').textContent = error.message; }
};
$('refresh-metrics').onclick = () => refreshMetrics().catch(error => showNotice(error.message));
initialize().catch(error => { $('login').classList.remove('hidden'); $('login-error').textContent = error.message; });
