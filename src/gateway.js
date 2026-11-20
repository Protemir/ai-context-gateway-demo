// AI gateway core: measure -> classify -> (strategy) -> provider -> journal + metrics.
// Runtime-agnostic: the same code runs in the Cloudflare Worker and in Node tests.
import { measure, CLASS } from './policy.js';
import { GatewayError, ProviderError, errors } from './errors.js';
import { trimHistory, summarize, split } from './strategies.js';

const ROLES = new Set(['system', 'user', 'assistant', 'tool', 'developer']);

export async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function validate(body, cfg) {
  if (!body || typeof body !== 'object') throw errors.bad('ожидается JSON-объект');
  const msgs = body.messages;
  if (!Array.isArray(msgs) || !msgs.length) throw errors.bad('нужен непустой массив messages');
  if (msgs.length > 2000) throw errors.bad('слишком много сообщений (больше 2000)');
  for (const m of msgs) {
    if (!m || !ROLES.has(m.role)) throw errors.bad('у каждого сообщения должна быть роль system/user/assistant/tool');
    if (m.content != null && typeof m.content !== 'string' && !Array.isArray(m.content)) throw errors.bad('content — строка или массив частей');
  }
  const mt = body.max_tokens;
  if (mt != null && (!Number.isInteger(mt) || mt < 1)) throw errors.bad('max_tokens — целое число больше 0');
  const reserve = mt ?? cfg.reserveTokens;
  if (reserve >= cfg.limit) throw errors.bad(`max_tokens (${reserve}) не меньше лимита контекста (${cfg.limit})`);
  return { messages: msgs.map((m) => ({ role: m.role === 'developer' ? 'system' : m.role, content: m.content ?? '' })), reserve };
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./counter.js').makeCounter>} deps.counter
 * @param {object} deps.ledger   begin/finish (MemoryLedger or the Durable Object)
 * @param {() => number} [deps.now]
 */
export function createGateway({ counter, ledger, now = () => Date.now() }) {
  async function handle(body, { cfg, provider, client = 'default', budget = null, requestId }) {
    const t0 = now();
    const id = requestId || crypto.randomUUID();
    const deltas = {};
    const inc = (k, by = 1) => { deltas[k] = (deltas[k] || 0) + by; };
    const entry = {
      ts: new Date(t0).toISOString(),
      request_id: id,
      mode: provider.live ? 'live' : 'mock',
      model: counter.model.name,
      strategy: cfg.strategy,
      limit: cfg.limit,
    };
    let block = null;
    let fp = null;
    let neurons = 0;
    let upstreamCalls = 0;
    let lastProviderPrompt = null;

    // one provider call; never sends a payload that does not fit, never retries size errors
    const call = async (messages, maxTokens, purpose) => {
      const size = counter.prompt(messages).total;
      if (size + maxTokens > cfg.limit || counter.admission(messages) > counter.model.contextWindow) {
        throw errors.cannotFit(cfg.strategy, { maxInput: cfg.limit - maxTokens }, `внутренний вызов «${purpose}» не помещается`);
      }
      if (budget && provider.live) {
        const est = (size / 1000) * counter.model.neuronsPer1kIn + (maxTokens / 1000) * counter.model.neuronsPer1kOut;
        if (budget.remaining < est) throw errors.budget();
        if (budget.perCall && est > budget.perCall) throw errors.callCap(Math.round(est));
      }
      let attempt = 0;
      for (;;) {
        upstreamCalls++;
        inc(`gateway_upstream_calls_total{purpose="${purpose}"}`);
        try {
          const r = await provider.chat({ messages, max_tokens: maxTokens });
          const n = Number(r.usage?.neurons || 0);
          neurons += n;
          if (budget) budget.remaining -= n;
          lastProviderPrompt = r.usage?.prompt_tokens ?? null;
          if (lastProviderPrompt != null) {
            inc('gateway_count_checks_total');
            if (lastProviderPrompt !== size) inc('gateway_count_mismatch_total');
          }
          if (!r.text && r.finish === 'length') {
            // reasoning models spend max_tokens on reasoning too: the answer reserve was too small
            inc('gateway_answer_reserve_exhausted_total');
            entry.warning = 'ANSWER_RESERVE_EXHAUSTED';
          }
          return r;
        } catch (e) {
          const pe = e instanceof ProviderError ? e : new ProviderError('error', String(e?.message || e));
          entry.upstream_error = pe.message.slice(0, 200);
          // an opaque error on a payload close to the model window is treated as a size problem
          const suspectSize = pe.kind === 'error' && size > counter.model.contextWindow * 0.9;
          if (pe.kind === 'size' || suspectSize) {
            inc('gateway_upstream_size_rejections_total');
            throw Object.assign(errors.upstreamSize(pe.message.slice(0, 300)), { sizeReject: true });
          }
          inc(`gateway_upstream_errors_total{kind="${pe.kind}"}`);
          if (attempt < cfg.retry.upstreamRetries) { attempt++; inc('gateway_upstream_retries_total'); continue; }
          throw pe.kind === 'timeout' ? errors.timeout() : errors.upstream(pe.message.slice(0, 300));
        }
      }
    };

    try {
      const { messages, reserve } = validate(body, cfg);
      fp = await sha256hex(JSON.stringify([client, counter.model.id, cfg.limit, reserve, messages]));
      entry.fp = fp.slice(0, 16);
      const content = await sha256hex(JSON.stringify(messages));
      entry.content_sha256 = content.slice(0, 16); // proves identity of payload without storing it

      // TZ 3.4: an identical request already rejected for size is answered locally
      const pre = await ledger.begin({ fp });
      if (pre?.blocked) {
        inc('gateway_repeat_blocked_total');
        entry.class = CLASS.OVER;
        entry.estimated_tokens = pre.blocked.estimated_tokens ?? null;
        entry.reserve = reserve;
        entry.max_input = cfg.limit - reserve;
        throw errors.repeat({ first_request_id: pre.blocked.request_id, estimated_tokens: pre.blocked.estimated_tokens });
      }

      const m = measure(counter, messages, { limit: cfg.limit, reserve, nearBand: cfg.nearBand, fastPath: cfg.fastPath });
      Object.assign(entry, {
        class: m.cls,
        method: m.method,
        estimated_tokens: m.tokens ?? null,
        upper_bound: m.upperBound ?? null,
        reserve,
        max_input: m.maxInput,
        admission_estimate: m.admission,
        over_reason: m.reason,
      });
      inc(`gateway_requests_total{class="${m.cls}"}`);

      let result;
      let forwarded = 'original';
      let actions = {};
      let applied = null;
      if (m.cls !== CLASS.OVER) {
        result = await call(messages, reserve, 'main');
      } else {
        inc(`gateway_overflow_total{strategy="${cfg.strategy}"}`);
        const strategy = cfg.strategy;
        try {
          if (strategy === 'reject') {
            throw m.reason === 'provider_admission' ? errors.overAdmission(m, counter.model.contextWindow) : errors.overLimit(m);
          }
          applied = strategy;
          if (strategy === 'trim_history') {
            const r = trimHistory(messages, counter, m, cfg);
            actions = r.actions;
            forwarded = 'modified';
            result = await call(r.messages, reserve, 'main');
          } else if (strategy === 'summarize') {
            const r = await summarize(messages, counter, m, cfg, call);
            actions = r.actions;
            forwarded = 'modified';
            result = await call(r.messages, reserve, 'main');
          } else if (strategy === 'split') {
            const r = await split(messages, counter, m, cfg, call, reserve);
            actions = r.actions;
            forwarded = 'modified';
            result = r.answer;
          } else {
            throw errors.bad(`неизвестная стратегия ${strategy}`);
          }
        } catch (e) {
          if (e instanceof GatewayError && e.status === 413) {
            // rejected for size: remember it so an identical retry is not processed again
            block = { fp, request_id: id, estimated_tokens: m.tokens };
            inc(`gateway_overflow_outcome_total{outcome="rejected"}`);
          }
          throw e;
        }
        inc(`gateway_overflow_outcome_total{outcome="handled"}`);
        if (actions.dropped_messages) inc('gateway_messages_dropped_total', actions.dropped_messages);
        if (actions.summarized_messages) inc('gateway_messages_summarized_total', actions.summarized_messages);
        if (actions.parts) inc('gateway_split_parts_total', actions.parts);
      }

      const latency = now() - t0;
      Object.assign(entry, {
        result: 'ok',
        http_status: 200,
        applied,
        actions,
        forwarded,
        provider_prompt_tokens: lastProviderPrompt,
        upstream_calls: upstreamCalls,
        neurons: Math.round(neurons * 100) / 100,
        latency_ms: latency,
      });
      inc('gateway_responses_total{status="200"}');
      inc('gateway_latency_ms_sum', latency);
      await ledger.finish({ entry, deltas, block: null, neurons });
      return {
        status: 200,
        body: {
          id: 'chatcmpl-' + id,
          object: 'chat.completion',
          model: counter.model.name,
          choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: result.finish || 'stop' }],
          usage: result.usage,
          gateway: {
            request_id: id,
            class: m.cls,
            method: m.method,
            tokens: {
              estimated: m.tokens,
              upper_bound: m.upperBound,
              limit: m.limit,
              reserve: m.reserve,
              max_input: m.maxInput,
              per_message: m.perMessage,
              provider_admission_estimate: m.admission,
              provider_prompt: lastProviderPrompt,
            },
            strategy: cfg.strategy,
            applied,
            actions,
            forwarded,
            upstream_calls: upstreamCalls,
            warning: entry.warning || null,
            latency_ms: latency,
          },
        },
      };
    } catch (e0) {
      const e = e0 instanceof GatewayError ? e0 : errors.internal();
      if (!(e0 instanceof GatewayError)) {
        inc('gateway_internal_errors_total');
        entry.internal = String(e0?.stack || e0).slice(0, 300);
      }
      if (e0?.sizeReject && fp) block = { fp, request_id: id, estimated_tokens: entry.estimated_tokens };
      const latency = now() - t0;
      Object.assign(entry, {
        result: e.code,
        http_status: e.status,
        provider_prompt_tokens: lastProviderPrompt,
        upstream_calls: upstreamCalls,
        neurons: Math.round(neurons * 100) / 100,
        latency_ms: latency,
      });
      inc(`gateway_responses_total{status="${e.status}"}`);
      inc(`gateway_errors_total{code="${e.code}"}`);
      inc('gateway_latency_ms_sum', latency);
      try {
        await ledger.finish({ entry, deltas, block: block ? { ...block, seconds: cfg.retry.repeatBlockSeconds } : null, neurons });
      } catch { /* journal failure must not break the answer */ }
      return {
        status: e.status,
        body: {
          error: {
            code: e.code,
            message: e.message,
            message_en: e.messageEn,
            request_id: id,
            details: {
              ...e.details,
              estimated_tokens: entry.estimated_tokens ?? null,
              limit: cfg.limit,
              reserve: entry.reserve ?? null,
              max_input: entry.max_input ?? null,
              strategy: cfg.strategy,
              class: entry.class ?? null,
            },
          },
        },
      };
    }
  }

  /** Measurement only (no provider call): for the demo's live counter. */
  function count(body, cfg) {
    const { messages, reserve } = validate(body, cfg);
    const m = measure(counter, messages, { limit: cfg.limit, reserve, nearBand: cfg.nearBand, fastPath: false });
    return { class: m.cls, tokens: m.tokens, per_message: m.perMessage, limit: m.limit, reserve: m.reserve, max_input: m.maxInput, near_from: m.nearFrom, provider_admission_estimate: m.admission, over_reason: m.reason, overhead: counter.model.template };
  }

  return { handle, count };
}

/** In-memory ledger (tests, local runs). The Worker uses a Durable Object with the same interface. */
export class MemoryLedger {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.counters = {};
    this.entries = [];
    this.blocks = new Map();
  }
  async begin({ fp }) {
    const b = this.blocks.get(fp);
    if (b && b.until > this.now()) return { blocked: b };
    return { blocked: null };
  }
  async finish({ entry, deltas, block }) {
    for (const [k, v] of Object.entries(deltas)) this.counters[k] = (this.counters[k] || 0) + v;
    this.entries.push(entry);
    if (block) this.blocks.set(block.fp, { ...block, until: this.now() + block.seconds * 1000 });
  }
  async metrics() { return this.counters; }
  async journal(limit = 50) { return this.entries.slice(-limit).reverse(); }
}

/** Prometheus text exposition of the counters. */
export function prometheus(counters) {
  const lines = [];
  const seen = new Set();
  for (const key of Object.keys(counters).sort()) {
    const name = key.split('{')[0];
    if (!seen.has(name)) {
      seen.add(name);
      lines.push(`# TYPE ${name} counter`);
    }
    lines.push(`${key} ${counters[key]}`);
  }
  return lines.join('\n') + '\n';
}
