// Cloudflare Worker: OpenAI-compatible AI gateway with context-overflow handling.
//   POST /v1/chat/completions  — the gateway (body: OpenAI chat request + optional `gateway` overrides)
//   POST /v1/count             — measurement only, no model call
//   POST /v1/raw               — the same request straight to the provider, without the gateway (demo comparison)
//   GET  /metrics              — Prometheus counters;  GET /metrics.json
//   GET  /journal?limit=50     — technical journal (no message content); ?ids=a,b,c
//   GET  /config, /health
import vocab from './tokenizer/o200k_base.bin';
import { BpeTokenizer, HARMONY_SPECIALS } from './tokenizer/bpe.js';
import { makeCounter } from './counter.js';
import { DEFAULT_CONFIG, DEMO_BOUNDS, mergeConfig } from './config.js';
import { createGateway, prometheus, sha256hex } from './gateway.js';
import { workersAiProvider, mockProvider, classifyProviderError } from './providers.js';
import { errors, GatewayError } from './errors.js';
export { Ledger } from './ledger-do.js';

const tok = new BpeTokenizer(new Uint8Array(vocab), HARMONY_SPECIALS);
const counter = makeCounter(tok, DEFAULT_CONFIG.model);

const DAILY_NEURONS = 1500; // own daily cap, well below the free 10 000 (shared with other demos)
const PER_IP_LIVE = 60; // real model calls per IP per day
const PER_IP_ALL = 4000;
const MAX_BODY = 1_500_000;
const ORIGINS = [/^https:\/\/temirlab\.com$/, /^https:\/\/[a-z0-9-]+\.temirlab\.pages\.dev$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

function cors(origin) {
  const ok = ORIGINS.some((r) => r.test(origin || ''));
  return {
    'access-control-allow-origin': ok ? origin : 'https://temirlab.com',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-request-id',
    'access-control-expose-headers': 'x-request-id, x-gateway-class',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

const json = (body, status, origin, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors(origin), ...extra } });

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

/** Demo overrides from the `gateway` field of the body, bounded. */
function configFor(over = {}, live) {
  const o = {};
  if (Number.isInteger(over.limit)) o.limit = clamp(over.limit, DEMO_BOUNDS.limit);
  if (Number.isInteger(over.reserve_tokens)) o.reserveTokens = clamp(over.reserve_tokens, DEMO_BOUNDS.reserveTokens);
  if (DEMO_BOUNDS.strategies.includes(over.strategy)) o.strategy = over.strategy;
  if (typeof over.truncate_last_message === 'boolean') o.trim = { truncateLastMessage: over.truncate_last_message };
  if (typeof over.fast_path === 'boolean') o.fastPath = over.fast_path;
  return mergeConfig(DEFAULT_CONFIG, o);
}

function day() {
  return new Date().toISOString().slice(0, 10);
}

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('origin');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    const url = new URL(req.url);
    const stub = env.LEDGER.get(env.LEDGER.idFromName('global'));
    try {
      if (req.method === 'GET') {
        if (url.pathname === '/' || url.pathname === '/health') {
          return json({ ok: true, service: 'ai-context-gateway-demo', model: counter.model.name, docs: 'https://github.com/Protemir/ai-context-gateway-demo' }, 200, origin);
        }
        if (url.pathname === '/config') {
          const { model, ...rest } = DEFAULT_CONFIG;
          return json({ model, config: rest, bounds: DEMO_BOUNDS, demo: { daily_neurons: DAILY_NEURONS, neurons_today: await stub.budget(day()) } }, 200, origin);
        }
        if (url.pathname === '/metrics') {
          return new Response(prometheus(await stub.metrics()), { headers: { 'content-type': 'text/plain; version=0.0.4', ...cors(origin) } });
        }
        if (url.pathname === '/metrics.json') return json(await stub.metrics(), 200, origin);
        if (url.pathname === '/journal') {
          const ids = url.searchParams.get('ids');
          return json(await stub.journal(Number(url.searchParams.get('limit') || 50), ids ? ids.split(',').slice(0, 500) : null), 200, origin);
        }
        return json({ error: { code: 'NOT_FOUND' } }, 404, origin);
      }

      if (req.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED' } }, 405, origin);
      const len = Number(req.headers.get('content-length') || 0);
      if (len > MAX_BODY) return json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Тело запроса больше 1,5 МБ — это ограничение демо, а не шлюза.' } }, 413, origin);
      let body;
      try {
        const text = await req.text();
        if (text.length > MAX_BODY) throw new Error('big');
        body = JSON.parse(text);
      } catch {
        return json({ error: { code: 'BAD_REQUEST', message: 'Тело запроса — не JSON или больше 1,5 МБ.' } }, 400, origin);
      }
      const over = body?.gateway || {};
      const live = over.mode === 'live';
      const cfg = configFor(over, live);
      delete body.gateway;

      if (url.pathname === '/v1/count') {
        try {
          return json(createGateway({ counter, ledger: null }).count(body, cfg), 200, origin);
        } catch (e) {
          if (e instanceof GatewayError) return json({ error: { code: e.code, message: e.message } }, e.status, origin);
          throw e;
        }
      }

      const ip = req.headers.get('cf-connecting-ip') || 'local';
      const ipKey = (await sha256hex('ip:' + ip)).slice(0, 16);
      const today = day();

      if (url.pathname === '/v1/raw') {
        // the same request without the gateway: to show what the provider does on its own.
        // Only cheap or certainly-refused requests are let through (no near-window inference).
        const msgs = body?.messages;
        if (!Array.isArray(msgs) || !msgs.length) return json({ error: { code: 'BAD_REQUEST' } }, 400, origin);
        const p = counter.prompt(msgs).total;
        if (p > 3000 && p <= counter.model.contextWindow && counter.admission(msgs) <= counter.model.contextWindow) {
          return json({ error: { code: 'DEMO_RAW_NOT_ALLOWED', message: 'Без шлюза в демо отправляются только короткие запросы (до 3 000 токенов) или заведомо больше окна модели — чтобы не тратить бюджет.' } }, 422, origin);
        }
        const pre = await stub.begin({ fp: 'raw', day: today, ipKey, live: true });
        if (pre.ipLive >= PER_IP_LIVE) return json({ error: { code: 'DEMO_RATE_LIMIT' } }, 429, origin);
        if (pre.neuronsToday > DAILY_NEURONS) return json({ error: { code: 'DEMO_BUDGET_EXHAUSTED' } }, 429, origin);
        const t0 = Date.now();
        try {
          const out = await env.AI.run(counter.model.id, { messages: msgs, max_tokens: Math.min(body.max_tokens || 256, 512), reasoning: { effort: 'low' } });
          ctx.waitUntil(stub.finish({ entry: { request_id: 'raw-' + crypto.randomUUID(), ts: new Date().toISOString(), mode: 'raw', result: 'ok', estimated_tokens: p, upstream_calls: 1 }, ipKey, deltas: { 'demo_raw_calls_total{result="ok"}': 1 }, neurons: out?.usage?.neurons || 0, day: today }));
          return json({ ok: true, ms: Date.now() - t0, provider_response: out }, 200, origin);
        } catch (e) {
          const pe = classifyProviderError(e);
          ctx.waitUntil(stub.finish({ entry: { request_id: 'raw-' + crypto.randomUUID(), ts: new Date().toISOString(), mode: 'raw', result: 'provider_error', estimated_tokens: p }, deltas: { 'demo_raw_calls_total{result="error"}': 1 }, neurons: 0, day: today }));
          return json({ ok: false, ms: Date.now() - t0, provider_error: pe.message, our_count: p, provider_admission_estimate: counter.admission(msgs) }, 200, origin);
        }
      }

      if (url.pathname !== '/v1/chat/completions') return json({ error: { code: 'NOT_FOUND' } }, 404, origin);

      // live demo: own daily budget + one call capped at ~16k tokens (the gateway itself has no such cap)
      const budget = { remaining: DAILY_NEURONS, perCall: 320 };
      const ledger = {
        async begin({ fp }) {
          const r = await stub.begin({ fp, day: today, ipKey, live });
          if (r.ipAll > PER_IP_ALL) throw errors.rate();
          if (live && r.ipLive >= PER_IP_LIVE) throw errors.rate();
          budget.remaining = DAILY_NEURONS - (r.neuronsToday || 0);
          return r;
        },
        // journal/metrics are written in the background: they never delay or break the answer
        finish: (x) => { ctx.waitUntil(stub.finish({ ...x, day: today, ipKey }).catch(() => {})); },
      };
      const provider = live
        ? workersAiProvider(env.AI, counter.model, cfg.upstreamTimeoutMs)
        : mockProvider(counter, { fault: ['upstream_500', 'timeout', 'size_reject', 'flaky'].includes(over.mock_fault) ? over.mock_fault : null });
      const rid = (req.headers.get('x-request-id') || '').replace(/[^\w.-]/g, '').slice(0, 64) || undefined;
      const gw = createGateway({ counter, ledger });
      // repeat-guard scope: the caller (an API key in production; here a demo session or the IP)
      const client = typeof over.client === 'string' && over.client ? 'c:' + over.client.replace(/[^\w.-]/g, '').slice(0, 64) : 'ip:' + ipKey;
      const res = await gw.handle(body, { cfg, provider, client, budget: live ? budget : null, requestId: rid });
      const cls = res.body.gateway?.class || res.body.error?.details?.class || '';
      return json(res.body, res.status, origin, { 'x-request-id': res.body.gateway?.request_id || res.body.error?.request_id || '', 'x-gateway-class': cls });
    } catch (e) {
      // last line of defence: never an unhandled crash
      return json({ error: { code: 'GATEWAY_INTERNAL', message: 'Внутренняя ошибка шлюза.', detail: String(e?.message || e).slice(0, 200) } }, 500, origin);
    }
  },
};
