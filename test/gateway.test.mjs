import test from 'node:test';
import assert from 'node:assert/strict';
import { counter, setup } from './helpers.mjs';
import { dialogOfTokens, rng, textOfTokens, wordList } from '../src/testset.js';
import { prometheus } from '../src/gateway.js';

const r = rng(1);
const LIMIT = 8192, RESERVE = 512, MAX_IN = LIMIT - RESERVE;

test('5.1 well below the limit: forwarded unchanged, fast path', async () => {
  const { send, provider } = setup();
  const res = await send({ messages: [{ role: 'user', content: 'Где мой заказ 48213?' }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.gateway.class, 'within');
  assert.equal(res.body.gateway.method, 'upper_bound');
  assert.equal(res.body.gateway.forwarded, 'original');
  assert.equal(provider.state.calls, 1);
});

test('5.2 exactly at the limit is "near" and passes; +1 token is "over"', async () => {
  const { send } = setup({ strategy: 'reject' });
  const at = dialogOfTokens(counter, r, MAX_IN);
  assert.equal(counter.prompt(at).total, MAX_IN);
  const a = await send({ messages: at });
  assert.equal(a.status, 200);
  assert.equal(a.body.gateway.class, 'near');
  assert.equal(a.body.gateway.tokens.estimated, MAX_IN);
  const over = dialogOfTokens(counter, r, MAX_IN + 1);
  const b = await send({ messages: over });
  assert.equal(b.status, 413);
  assert.equal(b.body.error.code, 'CONTEXT_LIMIT_EXCEEDED');
  assert.equal(b.body.error.details.estimated_tokens, MAX_IN + 1);
  assert.match(b.body.error.message, /7\s680/);
});

test('reserve for the answer: max_tokens moves the threshold', async () => {
  const { send } = setup({ strategy: 'reject' });
  const msgs = dialogOfTokens(counter, r, LIMIT - 1024);
  assert.equal((await send({ messages: msgs, max_tokens: 1024 })).body.gateway.class, 'near');
  assert.equal((await send({ messages: msgs, max_tokens: 1025 })).status, 413);
});

test('5.3 reject: clear 413, provider never called', async () => {
  const { send, provider } = setup({ strategy: 'reject' });
  const res = await send({ messages: dialogOfTokens(counter, r, 20000) });
  assert.equal(res.status, 413);
  assert.equal(provider.state.calls, 0);
  assert.ok(res.body.error.message_en);
});

test('5.3 trim_history: keeps system + last user message, drops the oldest, adds a note', async () => {
  const { send, provider } = setup({ strategy: 'trim_history' });
  const msgs = dialogOfTokens(counter, r, 20000, { turns: 12, system: true });
  const res = await send({ messages: msgs });
  assert.equal(res.status, 200);
  assert.equal(res.body.gateway.class, 'over');
  assert.equal(res.body.gateway.forwarded, 'modified');
  assert.ok(res.body.gateway.actions.dropped_messages > 0);
  const sent = provider.state.sent[0];
  assert.deepEqual(sent[0], msgs[0]);
  assert.deepEqual(sent[sent.length - 1], msgs[msgs.length - 1]);
  assert.match(sent[1].content, /Шлюз/);
  assert.ok(counter.prompt(sent).total <= MAX_IN);
});

test('trim_history: a single giant message -> controlled 413 (or truncation if enabled)', async () => {
  const big = { messages: [{ role: 'user', content: textOfTokens(counter.tok, r, 12000, 'ru') }] };
  const a = await setup({ strategy: 'trim_history' }).send(big);
  assert.equal(a.status, 413);
  assert.equal(a.body.error.code, 'CONTEXT_LIMIT_EXCEEDED_AFTER_STRATEGY');
  const { send, provider } = setup({ strategy: 'trim_history', trim: { truncateLastMessage: true, addNote: true } });
  const b = await send(big);
  assert.equal(b.status, 200);
  assert.ok(b.body.gateway.actions.truncated_tokens > 4000);
  assert.ok(counter.prompt(provider.state.sent[0]).total <= MAX_IN);
  assert.match(provider.state.sent[0][0].content, /шлюз опустил/);
});

test('5.3 summarize: old turns replaced by a summary, recent turns kept verbatim', async () => {
  const { send, provider } = setup({ strategy: 'summarize' });
  const msgs = dialogOfTokens(counter, r, 25000, { turns: 16, system: true, lang: 'ru' });
  const res = await send({ messages: msgs });
  assert.equal(res.status, 200, JSON.stringify(res.body.error));
  const a = res.body.gateway.actions;
  assert.ok(a.summarized_messages > 0 && a.summary_calls >= 1);
  const final = provider.state.sent[provider.state.sent.length - 1];
  assert.match(final[1].content, /Краткое содержание/);
  assert.deepEqual(final[final.length - 1], msgs[msgs.length - 1]);
  assert.ok(counter.prompt(final).total <= MAX_IN);
  for (const call of provider.state.sent) assert.ok(counter.prompt(call).total <= LIMIT);
});

test('5.3 split: big document answered by map-reduce, every call fits', async () => {
  const { send, provider } = setup({ strategy: 'split' });
  const doc = textOfTokens(counter.tok, r, 20000, 'ru');
  const res = await send({ messages: [{ role: 'system', content: 'Ты аналитик колл-центра.' }, { role: 'user', content: doc + '\n\nСколько раз упоминается Караганда?' }] });
  assert.equal(res.status, 200, JSON.stringify(res.body.error));
  const parts = res.body.gateway.actions.parts;
  assert.ok(parts >= 3);
  assert.equal(provider.state.calls, parts + 1);
  for (const call of provider.state.sent) assert.ok(counter.prompt(call).total <= LIMIT - 400 || call === provider.state.sent.at(-1));
  assert.match(provider.state.sent.at(-1).at(-1).content, /Собери/);
});

test('split: too many parts -> CONTEXT_TOO_LARGE_FOR_SPLIT', async () => {
  const { send } = setup({ strategy: 'split' });
  const res = await send({ messages: [{ role: 'user', content: textOfTokens(counter.tok, r, 60000, 'en') }] });
  assert.equal(res.status, 413);
  assert.equal(res.body.error.code, 'CONTEXT_TOO_LARGE_FOR_SPLIT');
});

test('5.4 repeat of a rejected request is answered locally, no provider call', async () => {
  const { send, provider, ledger } = setup({ strategy: 'reject' });
  const body = { messages: dialogOfTokens(counter, r, 9000) };
  const a = await send(body);
  const b = await send(body);
  assert.equal(a.status, 413);
  assert.equal(b.status, 413);
  assert.equal(b.body.error.code, 'REPEATED_OVERSIZE_REQUEST');
  assert.equal(b.body.error.details.first_request_id, a.body.error.request_id);
  assert.equal(provider.state.calls, 0);
  assert.equal(ledger.counters.gateway_repeat_blocked_total, 1);
  // a changed request is processed again
  const c = await send({ messages: dialogOfTokens(counter, r, 9001) });
  assert.equal(c.body.error.code, 'CONTEXT_LIMIT_EXCEEDED');
});

test('5.5 provider errors are separated from local overflow', async () => {
  const msgs = { messages: [{ role: 'user', content: 'Статус лида 104233?' }] };
  const e500 = await setup({}, { fault: 'upstream_500' }).send(msgs);
  assert.equal(e500.status, 502);
  assert.equal(e500.body.error.code, 'UPSTREAM_ERROR');
  assert.equal(e500.body.error.details.class, 'within');
  const t = await setup({}, { fault: 'timeout' }).send(msgs);
  assert.equal(t.body.error.code, 'UPSTREAM_TIMEOUT');
  const s = setup({}, { fault: 'size_reject' });
  const sz = await s.send(msgs);
  assert.equal(sz.body.error.code, 'UPSTREAM_CONTEXT_REJECTED');
  assert.equal(s.provider.state.calls, 1, 'a size rejection is never retried as-is');
  const again = await s.send(msgs);
  assert.equal(again.body.error.code, 'REPEATED_OVERSIZE_REQUEST');
  assert.equal(s.provider.state.calls, 1);
  const f = setup({}, { fault: 'flaky' });
  const ok = await f.send(msgs);
  assert.equal(ok.status, 200);
  assert.equal(f.provider.state.calls, 2);
  assert.equal(f.ledger.counters['gateway_upstream_retries_total'], 1);
});

test('provider window: our count blocks what the provider would turn into 3030', async () => {
  const { send, provider } = setup({ strategy: 'reject', limit: 128000 });
  const res = await send({ messages: [{ role: 'user', content: '7,'.repeat(66000) }], max_tokens: 1024 });
  assert.equal(res.status, 413);
  assert.equal(provider.state.calls, 0);
  const ru = wordList(530000);
  assert.ok(counter.prompt([{ role: 'user', content: ru }]).total < 126976);
  const res2 = await send({ messages: [{ role: 'user', content: ru }], max_tokens: 1024 });
  assert.equal(res2.status, 413);
  assert.equal(res2.body.error.details.class, 'over');
  assert.match(res2.body.error.message, /по его оценке/);
});

test('journal: every field of TZ 3.5, and no message content', async () => {
  const { send, ledger } = setup({ strategy: 'reject' });
  const secret = 'Конфиденциально: клиент Иванов, телефон 7010000000. ';
  await send({ messages: [{ role: 'user', content: secret.repeat(1000) }] });
  const e = ledger.entries[0];
  for (const k of ['request_id', 'estimated_tokens', 'limit', 'strategy', 'result', 'max_input', 'reserve', 'class']) assert.ok(e[k] !== undefined && e[k] !== null, k);
  const j = JSON.stringify(ledger.entries);
  assert.ok(!j.includes('Иванов') && !j.includes('7010000000'));
});

test('metrics: the three TZ 3.6 counters exist in Prometheus format', async () => {
  const { send, ledger } = setup({ strategy: 'reject' });
  await send({ messages: [{ role: 'user', content: 'hi' }] });
  await send({ messages: dialogOfTokens(counter, r, 9000) });
  await setup({}, { fault: 'size_reject' }).send({ messages: [{ role: 'user', content: 'hi' }] }).then(() => {});
  const text = prometheus(ledger.counters);
  assert.match(text, /gateway_requests_total\{class="within"\} 1/);
  assert.match(text, /gateway_requests_total\{class="over"\} 1/);
  assert.match(text, /gateway_overflow_total\{strategy="reject"\} 1/);
});

test('bad input never crashes the gateway', async () => {
  const { send } = setup();
  const bad = [null, 42, 'x', {}, { messages: [] }, { messages: 'x' }, { messages: [{}] }, { messages: [{ role: 'hacker', content: 'x' }] },
    { messages: [{ role: 'user', content: { a: 1 } }] }, { messages: [{ role: 'user', content: 'x' }], max_tokens: -1 },
    { messages: [{ role: 'user', content: 'x' }], max_tokens: 99999 }, { messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }, { type: 'image_url' }] }] }];
  for (const b of bad) {
    const res = await send(b);
    assert.ok([200, 400].includes(res.status), JSON.stringify(b) + ' -> ' + res.status);
    assert.notEqual(res.body?.error?.code, 'GATEWAY_INTERNAL');
  }
  const rr = rng(99);
  for (let i = 0; i < 300; i++) {
    const msgs = [];
    const n = Math.floor(rr() * 5);
    for (let k = 0; k < n; k++) msgs.push({ role: ['user', 'assistant', 'system', 'tool', 'x'][Math.floor(rr() * 5)], content: rr() < 0.1 ? null : 'ä'.repeat(Math.floor(rr() * 50)) });
    const res = await send({ messages: msgs, max_tokens: rr() < 0.2 ? Math.floor(rr() * 10000) : undefined });
    assert.notEqual(res.status, 500);
  }
});
