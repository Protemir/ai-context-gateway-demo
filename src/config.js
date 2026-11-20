// Gateway configuration. Everything the pilot must "fix before the tests"
// (TZ 6.1: model, its limit, counting method, answer reserve, strategy) lives here.

export const MODEL_GPT_OSS_20B = {
  id: '@cf/openai/gpt-oss-20b',
  name: 'gpt-oss-20b',
  provider: 'Cloudflare Workers AI',
  contextWindow: 128000,
  tokenizer: 'o200k_harmony',
  // Chat template overhead, calibrated against usage.prompt_tokens of the provider:
  // prompt_tokens = base + perMessage * messages + sum(content tokens)
  template: { base: 65, perMessage: 4 },
  // The provider's own admission check (error 5021) is a character estimate, not tokens:
  // ceil((utf16 chars + base + perMessage * (messages - 1) + reasoningChars) / divisor) must be <= contextWindow.
  // reasoningChars: the provider also counts the JSON of the reasoning parameter we send ({"effort":"low"}).
  providerAdmission: { divisor: 4, base: 101, perMessage: 31, reasoningChars: 28 },
  // Workers AI pricing for the demo budget (neurons per 1k tokens, measured)
  neuronsPer1kIn: 18.2,
  neuronsPer1kOut: 27.3,
};

export const DEFAULT_CONFIG = {
  model: MODEL_GPT_OSS_20B,
  // Limit of the test contour (<= model context window). Prompt + answer reserve must fit.
  limit: 8192,
  // Answer reserve when the caller did not pass max_tokens.
  reserveTokens: 512,
  // Requests in the top `nearBand` share of the allowed input are classified "near".
  nearBand: 0.1,
  // What to do on overflow: reject | trim_history | summarize | split
  strategy: 'trim_history',
  // If the strategy cannot make the request fit: reject (413 with a clear code)
  fallback: 'reject',
  // Skip exact counting when a cheap upper bound (UTF-8 bytes) already proves the request is small.
  fastPath: true,
  trim: {
    // Cut the middle of the last message when it alone does not fit (else -> fallback)
    truncateLastMessage: false,
    // Tell the model that the gateway removed something
    addNote: true,
  },
  summarize: { maxSummaryTokens: 350 },
  split: { maxParts: 6, answerTokens: 700 },
  retry: {
    // Retries for provider errors that are NOT about size (5xx, timeout). Size errors are never retried as-is.
    upstreamRetries: 1,
    // An over-limit request rejected once is answered locally for this long (no new provider call).
    repeatBlockSeconds: 600,
  },
  upstreamTimeoutMs: 30000,
};

// Overrides a caller may send in the demo (`gateway` field). Bounded so the live demo stays cheap.
export const DEMO_BOUNDS = {
  limit: [256, 128000],
  liveLimitMax: 16384,
  reserveTokens: [0, 4096],
  strategies: ['reject', 'trim_history', 'summarize', 'split'],
};

export function mergeConfig(base, over = {}) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') out[k] = { ...out[k], ...v };
    else if (v !== undefined) out[k] = v;
  }
  return out;
}
