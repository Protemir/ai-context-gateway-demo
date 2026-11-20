// Cost of the gateway's own work (Node, one core): tokenizer start-up and exact counting.
//   node tools/bench.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BpeTokenizer, HARMONY_SPECIALS } from '../src/tokenizer/bpe.js';
import { makeCounter } from '../src/counter.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { measure } from '../src/policy.js';
import { dialogOfTokens, rng } from '../src/testset.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = new Uint8Array(fs.readFileSync(path.join(root, 'src/tokenizer/o200k_base.bin')));
let t = performance.now();
const tok = new BpeTokenizer(bin, HARMONY_SPECIALS);
const init = performance.now() - t;
const counter = makeCounter(tok, DEFAULT_CONFIG.model);
const r = rng(5);
const rows = [];
for (const size of [1000, 8000, 32000, 128000]) {
  const msgs = dialogOfTokens(counter, r, size, { turns: 10, lang: 'ru' });
  const fresh = new BpeTokenizer(bin, HARMONY_SPECIALS); // cold word cache
  const c2 = makeCounter(fresh, DEFAULT_CONFIG.model);
  t = performance.now();
  c2.prompt(msgs);
  const cold = performance.now() - t;
  const N = 5;
  t = performance.now();
  for (let i = 0; i < N; i++) measure(counter, msgs, { limit: 128000, reserve: 512, nearBand: 0.1, fastPath: false });
  const warm = (performance.now() - t) / N;
  rows.push({ tokens: size, chars: msgs.reduce((a, m) => a + m.content.length, 0), cold_ms: +cold.toFixed(1), warm_ms: +warm.toFixed(1) });
}
const out = { node: process.version, init_ms: +init.toFixed(0), rows };
fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
fs.writeFileSync(path.join(root, 'reports', 'bench.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
