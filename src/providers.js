// Model API adapters. Both return { text, finish, usage } or throw ProviderError.
import { ProviderError } from './errors.js';

const SIZE_RE = /\b5021\b|context window|context length|maximum context|too many tokens|prompt is too long/i;

/** Map a raw provider exception to size | timeout | error. */
export function classifyProviderError(e) {
  if (e instanceof ProviderError) return e;
  const msg = String(e?.message || e);
  if (SIZE_RE.test(msg)) return new ProviderError('size', msg, e);
  if (/timeout|timed out|aborted/i.test(msg)) return new ProviderError('timeout', msg, e);
  return new ProviderError('error', msg, e);
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new ProviderError('timeout', `timeout after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

/** Cloudflare Workers AI through the `AI` binding. */
export function workersAiProvider(ai, model, timeoutMs = 30000) {
  return {
    name: 'workers-ai',
    live: true,
    async chat({ messages, max_tokens, reasoning = 'low' }) {
      let out;
      try {
        out = await withTimeout(ai.run(model.id, { messages, max_tokens, reasoning: { effort: reasoning } }), timeoutMs);
      } catch (e) {
        throw classifyProviderError(e);
      }
      const choice = out?.choices?.[0];
      const text = choice?.message?.content ?? out?.response ?? '';
      return { text: text || '', finish: choice?.finish_reason || 'stop', usage: out?.usage || {} };
    },
  };
}

/**
 * Deterministic emulator of the same provider, reproducing what we measured on
 * Workers AI: error 5021 from the character-based admission check and an opaque
 * "3030: Internal Server Error" when the real token count exceeds the window.
 * `fault` injects provider failures for test scenario 5.5.
 */
export function mockProvider(counter, { fault = null } = {}) {
  const window = counter.model.contextWindow;
  const state = { calls: 0, sent: [] };
  return {
    name: 'mock',
    live: false,
    state,
    async chat({ messages, max_tokens }) {
      state.calls++;
      state.sent.push(messages);
      if (fault === 'upstream_500' || (fault === 'flaky' && state.calls === 1)) {
        throw new ProviderError('error', '3030: Internal Server Error');
      }
      if (fault === 'timeout') throw new ProviderError('timeout', 'timeout after 30000 ms (emulated)');
      if (fault === 'size_reject') {
        throw new ProviderError('size', `5021: The estimated number of input and maximum output tokens (${window + 1}) exceeded this model context window limit (${window}).`);
      }
      const adm = counter.admission(messages);
      if (adm > window) {
        throw new ProviderError('size', `5021: The estimated number of input and maximum output tokens (${adm}) exceeded this model context window limit (${window}).`);
      }
      const prompt = counter.prompt(messages).total;
      if (prompt > window) throw new ProviderError('error', '3030: Internal Server Error');
      const sys = messages[0]?.role === 'system' ? String(messages[0].content) : '';
      let text;
      if (sys.startsWith('Ты сжимаешь')) {
        // extractive "summary": first words of each line of the transcript
        const src = String(messages[messages.length - 1].content);
        text = src.split('\n').filter(Boolean).map((l) => l.split(/\s+/).slice(0, 8).join(' ')).join(' / ');
        text = counter.tok.decode(counter.tok.encode(text).slice(0, Math.max(16, (max_tokens || 300) - 50)));
      } else {
        text = `[эмулятор] Получено сообщений: ${messages.length}, токенов: ${prompt}.`;
      }
      const completion = counter.tok.count(text);
      return { text, finish: 'stop', usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, neurons: 0 } };
    },
  };
}
