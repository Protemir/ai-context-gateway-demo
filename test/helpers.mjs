import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BpeTokenizer, HARMONY_SPECIALS } from '../src/tokenizer/bpe.js';
import { makeCounter } from '../src/counter.js';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.js';
import { createGateway, MemoryLedger } from '../src/gateway.js';
import { mockProvider } from '../src/providers.js';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const tok = new BpeTokenizer(new Uint8Array(fs.readFileSync(path.join(root, 'src/tokenizer/o200k_base.bin'))), HARMONY_SPECIALS);
export const counter = makeCounter(tok, DEFAULT_CONFIG.model);

export function setup(over = {}, providerOpts = {}) {
  const cfg = mergeConfig(DEFAULT_CONFIG, over);
  const ledger = new MemoryLedger();
  const gw = createGateway({ counter, ledger });
  const provider = mockProvider(counter, providerOpts);
  const send = (body, opts = {}) => gw.handle(structuredClone(body), { cfg, provider: opts.provider || provider, requestId: opts.requestId });
  return { cfg, ledger, gw, provider, send };
}

/** Run test-set cases in process (same code path as the Worker, mock provider). */
export async function runCases(cases, strategy) {
  const ledger = new MemoryLedger();
  const gw = createGateway({ counter, ledger });
  const results = [];
  for (const c of cases) {
    const cfg = mergeConfig(DEFAULT_CONFIG, { strategy, ...(c.gateway.limit ? { limit: c.gateway.limit } : {}) });
    const provider = mockProvider(counter, { fault: c.gateway.mock_fault || null });
    const res = await gw.handle(structuredClone(c.body), { cfg, provider, requestId: c.id });
    results.push({ case: c, status: res.status, body: res.body, journal: ledger.entries.find((e) => e.request_id === c.id) || null, providerCalls: provider.state.calls });
  }
  return { results, ledger };
}
