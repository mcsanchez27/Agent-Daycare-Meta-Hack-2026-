// Meta engine driver: Muse Spark over an OpenAI-compatible chat-completions
// endpoint (Baseten today). Runs in the main process; the API key never
// leaves it. Streaming SSE deltas map onto the runner output lifecycle.
const DEFAULT_BASE_URL = 'https://inference.baseten.co/v1';
const DEFAULT_MODEL = 'meta-models/muse-spark-open-1026';

function loadMetaConfig(env = process.env) {
  const apiKey = env.BASETEN_API_KEY || env.META_API_KEY || '';
  if (!apiKey) {
    const err = new Error('Meta engine needs BASETEN_API_KEY (see .env.local).');
    err.code = 'META_NO_API_KEY';
    throw err;
  }
  return {
    apiKey,
    baseUrl: (env.BASETEN_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: env.META_SPARK_MODEL || DEFAULT_MODEL
  };
}

// One SSE "data:" payload parsed into text/usage, or {} when the line carries
// nothing to show. { done: true } ends the stream.
function parseSseData(payload) {
  const data = String(payload).trim();
  if (!data) return {};
  if (data === '[DONE]') return { done: true };
  let j;
  try {
    j = JSON.parse(data);
  } catch (_) {
    return {};
  }
  const out = {};
  const first = j.choices && j.choices[0];
  const delta = first && first.delta;
  if (delta && typeof delta.content === 'string' && delta.content) out.text = delta.content;
  const message = first && first.message;
  if (!out.text && message && typeof message.content === 'string' && message.content) out.text = message.content;
  if (j.usage) out.usage = { inputTokens: j.usage.prompt_tokens || 0, outputTokens: j.usage.completion_tokens || 0 };
  return out;
}

async function* textChunks(body) {
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    yield typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

async function chatCompletions({ apiKey, baseUrl, model, messages, signal, fetchImpl = globalThis.fetch, onDelta = null }) {
  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } }),
    signal
  });
  if (!res.ok) {
    const body = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
    const err = new Error(`Meta engine HTTP ${res.status}${body ? `: ${String(body).slice(0, 300)}` : ''}`);
    err.code = 'META_HTTP_ERROR';
    err.status = res.status;
    throw err;
  }
  let text = '';
  let usage = null;
  const emit = (ev) => {
    if (ev.text) {
      text += ev.text;
      if (onDelta) onDelta(ev.text);
    }
    if (ev.usage) usage = { ...usage, ...ev.usage };
  };
  let buffer = '';
  for await (const piece of textChunks(res.body)) {
    buffer += piece;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const ev = parseSseData(line.slice(5));
      if (ev.done) return { text, usage };
      emit(ev);
    }
  }
  if (buffer.trim().startsWith('data:')) {
    const ev = parseSseData(buffer.trim().slice(5));
    if (!ev.done) emit(ev);
  }
  return { text, usage };
}

module.exports = { loadMetaConfig, chatCompletions, parseSseData, DEFAULT_BASE_URL, DEFAULT_MODEL };