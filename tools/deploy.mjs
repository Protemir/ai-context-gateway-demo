// Deploys src/ as the Cloudflare Worker `ai-gateway-demo` (Workers AI + a SQLite Durable Object).
//   node tools/deploy.mjs <file with a Cloudflare API token>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const token = (process.env.CF_API_TOKEN || fs.readFileSync(process.argv[2], 'utf8')).trim();
const NAME = 'ai-gateway-demo';
const API = 'https://api.cloudflare.com/client/v4';
const MODULES = ['worker.js', 'ledger-do.js', 'gateway.js', 'policy.js', 'counter.js', 'config.js', 'errors.js', 'providers.js', 'strategies.js', 'tokenizer/bpe.js', 'tokenizer/o200k_base.bin'];

async function cf(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) throw new Error(`${method} ${url}: ${JSON.stringify(data.errors || data)}`);
  return data.result;
}

const account = (await cf('GET', '/accounts'))[0].id;

async function upload(withMigration) {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({
    main_module: 'worker.js',
    compatibility_date: '2026-10-01',
    bindings: [
      { type: 'ai', name: 'AI' },
      { type: 'durable_object_namespace', name: 'LEDGER', class_name: 'Ledger' },
    ],
    ...(withMigration ? { migrations: { new_tag: 'v1', new_sqlite_classes: ['Ledger'] } } : {}),
  })], { type: 'application/json' }));
  for (const m of MODULES) {
    const type = m.endsWith('.bin') ? 'application/octet-stream' : 'application/javascript+module';
    form.append(m, new Blob([fs.readFileSync(path.join(root, m))], { type }), m);
  }
  return cf('PUT', `/accounts/${account}/workers/scripts/${NAME}`, form);
}

try {
  await upload(true);
} catch (e) {
  if (!/migration|tag/i.test(String(e.message))) throw e;
  await upload(false);
}
const sub = (await cf('GET', `/accounts/${account}/workers/subdomain`)).subdomain;
await cf('POST', `/accounts/${account}/workers/scripts/${NAME}/subdomain`, { enabled: true, previews_enabled: false });
console.log(`https://${NAME}.${sub}.workers.dev`);
