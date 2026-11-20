// Runs the 320-request pilot protocol over HTTP against the deployed gateway
// (provider emulator mode) and writes reports/protocol-http-<strategy>.{json,md}.
//   node tools/run-protocol.mjs https://ai-gateway-demo.protemir.workers.dev trim_history
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { counter } from '../test/helpers.mjs';
import { buildTestSet, evaluate } from '../src/testset.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'https://ai-gateway-demo.protemir.workers.dev';
const strategy = process.argv[3] || 'trim_history';
const run = 'p' + Date.now().toString(36);
const cases = buildTestSet(counter);

async function send(c) {
  const body = { ...structuredClone(c.body), gateway: { mode: 'mock', strategy, client: run, ...(c.gateway.limit ? { limit: c.gateway.limit } : {}), ...(c.gateway.mock_fault ? { mock_fault: c.gateway.mock_fault } : {}) } };
  const t = performance.now();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': `${run}-${c.id}` }, body: JSON.stringify(body) });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { error: { code: 'NON_JSON', raw: text.slice(0, 200) } }; }
    if ((res.status === 503 || json.error?.code === 'NON_JSON') && attempt < 2) continue; // platform hiccup, not the gateway
    return { case: c, status: res.status, body: json, ms: performance.now() - t, attempts: attempt + 1 };
  }
}

const t0 = performance.now();
const results = new Array(cases.length);
const firstPass = cases.map((c, i) => [c, i]).filter(([c]) => !c.gateway.repeat_of);
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < firstPass.length) {
    const [c, i] = firstPass[next++];
    results[i] = await send(c);
  }
}));
for (const [i, c] of cases.entries()) if (c.gateway.repeat_of) results[i] = await send(c);

// journal entries for every request
const ids = cases.map((c) => `${run}-${c.id}`);
const journal = [];
for (let i = 0; i < ids.length; i += 80) {
  const r = await fetch(`${base}/journal?ids=${ids.slice(i, i + 80).join(',')}`);
  journal.push(...(await r.json()));
}
for (const x of results) x.journal = journal.find((e) => e.request_id === `${run}-${x.case.id}`) || null;

const ev = evaluate(results);
const ms = Math.round(performance.now() - t0);
const lat = results.map((x) => x.body?.gateway?.latency_ms ?? x.journal?.latency_ms).filter((v) => v != null).sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
const byScenario = {};
for (const x of results) {
  const s = (byScenario[x.case.scenario] ||= { total: 0, statuses: {} });
  s.total++;
  const k = x.status === 200 ? '200' : `${x.status} ${x.body?.error?.code}`;
  s.statuses[k] = (s.statuses[k] || 0) + 1;
}
const report = {
  run, base, strategy, date: new Date().toISOString(), ms,
  gateway_latency_ms: { p50: q(0.5), p95: q(0.95), max: lat.at(-1) },
  retries_platform: results.filter((x) => x.attempts > 1).length,
  byScenario, ...ev,
  samples: results.filter((_, i) => i % 40 === 0 || results[i].case.scenario === '5.5').slice(0, 20).map((x) => ({ id: x.case.id, note: x.case.note, status: x.status, code: x.status === 200 ? 'ok' : x.body.error?.code, gateway: x.body.gateway ? { class: x.body.gateway.class, tokens: x.body.gateway.tokens.estimated, applied: x.body.gateway.applied, actions: x.body.gateway.actions } : x.body.error?.details })),
};
fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
fs.writeFileSync(path.join(root, 'reports', `protocol-http-${strategy}.json`), JSON.stringify(report, null, 2));
const md = [
  `# Протокол испытаний: стратегия ${strategy}`,
  '',
  `Прогон ${run}, ${report.date}, шлюз ${base}, режим эмулятора провайдера. Запросов: ${ev.total}, время ${(ms / 1000).toFixed(1)} с, задержка шлюза p50 ${report.gateway_latency_ms.p50} мс, p95 ${report.gateway_latency_ms.p95} мс.`,
  '',
  '| Критерий ТЗ | Требование | Факт | Детали | Итог |',
  '|---|---|---|---|---|',
  ...ev.criteria.map((c) => `| ${c.id} ${c.name} | ${c.need} | ${c.value}${typeof c.value === 'number' && c.need.includes('%') ? '%' : ''} | ${c.detail} | ${c.pass ? 'выполнен' : 'НЕ выполнен'} |`),
  '',
  '## Ответы по сценариям',
  '',
  ...Object.entries(byScenario).map(([s, v]) => `- ${s}: ${v.total} запросов — ${Object.entries(v.statuses).map(([k, n]) => `${k}: ${n}`).join(', ')}`),
  '',
  ev.failures.length ? `## Расхождения\n\n${ev.failures.map((f) => `- ${f.id}: ожидалось ${f.expected}, получено ${f.got} (${f.status} ${f.code}) — ${f.note}`).join('\n')}` : 'Расхождений нет.',
].join('\n');
fs.writeFileSync(path.join(root, 'reports', `protocol-http-${strategy}.md`), md + '\n');
console.log(md);
