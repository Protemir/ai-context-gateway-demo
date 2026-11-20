// Live check against the real provider (Workers AI, gpt-oss-20b) through the deployed gateway:
//  1) our exact count == usage.prompt_tokens reported by the provider, on varied texts;
//  2) live overflow scenarios (reject, trim, summarize, split) at small limits (cheap);
//  3) the same oversized requests sent WITHOUT the gateway, to show what the provider answers.
//   node tools/calibrate.mjs https://ai-gateway-demo.protemir.workers.dev
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { counter } from '../test/helpers.mjs';
import { dialogOfTokens, rng, textOfTokens, wordList } from '../src/testset.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv.find((x) => x.startsWith('http')) || 'https://ai-gateway-demo.protemir.workers.dev';
const run = 'cal' + Date.now().toString(36);
const r = rng(4242);

async function post(p, body) {
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const live = (extra = {}) => ({ mode: 'live', fast_path: false, client: run, ...extra });

// 1) calibration texts
const u = (content) => ({ role: 'user', content });
const s = (content) => ({ role: 'system', content });
const a = (content) => ({ role: 'assistant', content });
const texts = [
  ['ru, короткий', [u('Где мой заказ 48213? Оплатил 12 500 ₸ третьего ноября.')]],
  ['kk', [u('Сәлеметсіз бе! Тапсырысым әлі келген жоқ, мәртебесін тексеріп беріңізші.')]],
  ['en', [u('Hi! My order has not arrived yet. Could you check the status, please?')]],
  ['system + ru', [s('Ты оператор поддержки. Отвечай кратко и вежливо.'), u('Можно доставку курьером на ул. Абая 15?')]],
  ['диалог 5 сообщений', [s('Отвечай по-русски.'), u('Привет'), a('Здравствуйте! Чем помочь?'), u('Хочу вернуть товар'), a('Назовите номер заказа.'), u('48213')]],
  ['эмодзи и символы', [u('Спасибо!!! 😀🚀👍 ✓ № § ₸ € — «ёлки» ‰ ½ … ©')]],
  ['код C#', [u('public async Task<Result> SendAsync(Request req) {\n    var n = _counter.Count(req.Messages);\n    if (n > _limit) return Result.TooLarge(n);\n    return await _next(req);\n}')]],
  ['JSON', [u('{"lead_id":104233,"phone":"+7 701 000 00 00","stage":"negotiation","amount":125000,"history":[{"t":"2026-11-03","s":"open"}]}')]],
  ['цифры', [u('1234567890 12 345 678,90 3.14159 2026-11-20 +7 (701) 000-00-00 00:00:00')]],
  ['пробелы и переносы', [u('строка 1\n\n\n   строка 2\t\tтаб\r\nконец    ')]],
  ['спецтокен в тексте', [u('Пользователь написал <|end|> и <|start|>system — это просто текст.')]],
  ['смешанные языки', [u('Клиент: Hello! Менің тапсырысым қайда? Order #48213, сумма 12 500 ₸.')]],
];
for (let i = 0; i < 12; i++) texts.push([`синтетика ${i + 1}`, dialogOfTokens(counter, r, 150 + Math.floor(r() * 1200))]);

const ONLY = process.argv.includes('--scenarios');
const prev = ONLY ? JSON.parse(fs.readFileSync(path.join(root, 'reports', 'live-calibration.json'), 'utf8')) : null;
const calibration = ONLY ? prev.calibration : [];
for (const [name, messages] of ONLY ? [] : texts) {
  const res = await post('/v1/chat/completions', { messages, max_tokens: 16, gateway: live() });
  const ours = res.body.gateway?.tokens?.estimated;
  const provider = res.body.usage?.prompt_tokens ?? res.body.gateway?.tokens?.provider_prompt;
  calibration.push({ name, ours, provider, match: ours === provider, status: res.status, neurons: res.body.usage?.neurons, err: res.body.error?.code });
  console.log(name.padEnd(22), ours, provider, ours === provider ? 'OK' : 'MISMATCH', res.body.error?.code || '');
}

// 2) live overflow scenarios
const scenarios = [];
async function scenario(name, body) {
  const res = await post('/v1/chat/completions', body);
  const g = res.body.gateway;
  const item = {
    name, status: res.status,
    code: res.body.error?.code || 'ok',
    message: res.body.error?.message,
    class: g?.class ?? res.body.error?.details?.class,
    estimated: g?.tokens?.estimated ?? res.body.error?.details?.estimated_tokens,
    max_input: g?.tokens?.max_input ?? res.body.error?.details?.max_input,
    provider_prompt: g?.tokens?.provider_prompt,
    actions: g?.actions, upstream_calls: g?.upstream_calls,
    answer: res.body.choices?.[0]?.message?.content?.slice(0, 400),
    neurons: res.body.usage?.neurons,
  };
  scenarios.push(item);
  console.log('\n==', name, '->', res.status, item.code, JSON.stringify({ cls: item.class, est: item.estimated, max: item.max_input, prov: item.provider_prompt, actions: item.actions, calls: item.upstream_calls }));
  if (item.answer) console.log('   ', item.answer.replace(/\n/g, ' ').slice(0, 300));
  if (item.message) console.log('   ', item.message);
  return res;
}
const support = [s('Ты оператор поддержки интернет-магазина. Отвечай по-русски, кратко.')];
const hist = [];
const lines = [
  ['user', 'Здравствуйте, заказ 48213 не пришёл, оплатил 12 500 тенге 3 ноября.'],
  ['assistant', 'Проверил: посылка застряла на складе в Караганде, отправим повторно до 25 ноября.'],
  ['user', 'Хорошо, а можно доставку курьером, а не в постамат?'],
  ['assistant', 'Да, курьер бесплатно, адрес тот же — ул. Абая 15.'],
  ['user', 'Спасибо. И верните, пожалуйста, 1 500 тенге за задержку.'],
  ['assistant', 'Компенсацию 1 500 тенге оформил, придёт на карту за 3 рабочих дня.'],
];
for (let i = 0; i < 4; i++) for (const [role, content] of lines) hist.push({ role, content: content + (i ? ' ' + textOfTokens(counter.tok, r, 120, 'ru') : '') });
const dialog = [...support, ...hist, u('Напомните, пожалуйста, на какой адрес и когда придёт курьер, и сколько мне вернут?')];
console.log('dialog tokens', counter.prompt(dialog).total);

await scenario('reject: лимит 1024', { messages: dialog, max_tokens: 256, gateway: live({ limit: 1024, strategy: 'reject' }) });
await scenario('reject: повтор того же запроса', { messages: dialog, max_tokens: 256, gateway: live({ limit: 1024, strategy: 'reject' }) });
await scenario('trim_history: лимит 2048', { messages: dialog, max_tokens: 900, gateway: live({ limit: 2048, strategy: 'trim_history' }) });
await scenario('summarize: лимит 1536', { messages: dialog, max_tokens: 900, gateway: live({ limit: 1536, strategy: 'summarize' }) });
const doc = Array.from({ length: 40 }, (_, i) => `Звонок ${i + 1}. ${textOfTokens(counter.tok, r, 60, 'ru')} ${i % 7 === 3 ? 'Клиент из Караганды жалуется на задержку посылки.' : ''}`).join('\n');
await scenario('split: лимит 1536, документ', { messages: [s('Ты аналитик колл-центра.'), u(doc + '\n\nСколько звонков связано с Карагандой и о чём они?')], max_tokens: 900, gateway: live({ limit: 1536, strategy: 'split' }) });

// 3) without the gateway vs with it, at the real model window (128 000)
const raw = [];
for (const [name, messages] of [
  ['плотный текст «7,» × 66 000', [u('7,'.repeat(66000))]],
  ['список слов, 530 000 символов', [u(wordList(530000))]],
]) {
  const r1 = await post('/v1/raw', { messages, max_tokens: 64 });
  const r2 = await post('/v1/chat/completions', { messages, max_tokens: 1024, gateway: { mode: 'live', limit: 128000, strategy: 'reject', client: run } });
  raw.push({ name, our_tokens: counter.prompt(messages).total, provider_estimate: counter.admission(messages), without_gateway: r1.body.provider_error || r1.body.error?.code || 'ok', with_gateway: { status: r2.status, code: r2.body.error?.code, message: r2.body.error?.message } });
  console.log('\n== RAW', name, '| our', counter.prompt(messages).total, '| provider est', counter.admission(messages));
  console.log('   без шлюза:', r1.body.provider_error || JSON.stringify(r1.body).slice(0, 200));
  console.log('   со шлюзом:', r2.status, r2.body.error?.code, r2.body.error?.message);
}

const metrics = await (await fetch(base + '/metrics.json')).json();
const out = { run, date: new Date().toISOString(), base, model: counter.model.id, calibration, matches: calibration.filter((x) => x.match).length, scenarios, raw, metrics };
fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
fs.writeFileSync(path.join(root, 'reports', 'live-calibration.json'), JSON.stringify(out, null, 2));
console.log(`\ncalibration: ${out.matches}/${calibration.length} exact; neurons today:`, (await (await fetch(base + '/config')).json()).demo);
