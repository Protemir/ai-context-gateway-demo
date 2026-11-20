// Full pilot protocol in process: 320 requests, criteria TZ 4.1–4.5 for two strategies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { counter, root, runCases } from './helpers.mjs';
import { buildTestSet, evaluate } from '../src/testset.js';

const cases = buildTestSet(counter);

test('test set: at least 300 requests, sizes hit their targets', () => {
  assert.ok(cases.length >= 300, String(cases.length));
  for (const c of cases.filter((x) => x.scenario === '5.2')) {
    const m = c.note.match(/^(\d+) токенов/);
    if (m) assert.equal(counter.prompt(c.body.messages).total, +m[1], c.id);
  }
});

for (const strategy of ['trim_history', 'reject', 'split']) {
  test(`protocol, strategy ${strategy}: all criteria pass`, async () => {
    const t = performance.now();
    const { results } = await runCases(cases, strategy);
    const ev = evaluate(results);
    const ms = Math.round(performance.now() - t);
    fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(root, 'reports', `protocol-local-${strategy}.json`), JSON.stringify({ strategy, ms, ...ev }, null, 2));
    for (const c of ev.criteria) assert.ok(c.pass, `${c.id} ${c.name}: ${c.detail}\n${JSON.stringify(ev.failures.slice(0, 5), null, 1)}`);
  });
}
