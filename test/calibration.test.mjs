// The counting method is checked against numbers returned by the live provider
// (Cloudflare Workers AI, @cf/openai/gpt-oss-20b, probes of 20.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { counter } from './helpers.mjs';

const u = (content) => ({ role: 'user', content });
const s = (content) => ({ role: 'system', content });
const a = (content) => ({ role: 'assistant', content });

// [messages, usage.prompt_tokens reported by the provider]
const PROMPT_PROBES = [
  [[u('x')], 70],
  [[u('hello world')], 71],
  [[s('x'), u('x')], 75],
  [[s('x'), s('y'), u('x')], 80],
  [[u('x'), a('y'), u('z')], 80],
  [[u('x'), a('y'), u('z'), a('y'), u('z')], 90],
  [[s('x'), u('x'), a('y'), u('z')], 85],
  [[u('x\n')], 71],
  [[u('')], 69],
  [[u('a <|end|> b')], 76],
  [[u('word '.repeat(3000) + 'x')], 3070],
];

test('template overhead: exact match with provider prompt_tokens', () => {
  for (const [msgs, expected] of PROMPT_PROBES) assert.equal(counter.prompt(msgs).total, expected, JSON.stringify(msgs).slice(0, 60));
});

// [messages, estimate printed in the provider's 5021 error]
const ADMISSION_PROBES = [
  [[u('x'.repeat(700000))], 175026],
  [[u('x'.repeat(700004))], 175027],
  [[u('x'.repeat(700001))], 175026],
  [[u('ж'.repeat(700000))], 175026],
  [[u('😀'.repeat(300000))], 150026],
  [[s('y'), u('x'.repeat(700000))], 175034],
  [[u('x'.repeat(350000)), u('x'.repeat(350000))], 175033],
  [[u('word '.repeat(140000) + 'x')], 175026],
];

test('provider admission estimate: exact match with error 5021', () => {
  // these probes were sent without the reasoning parameter
  for (const [msgs, expected] of ADMISSION_PROBES) assert.equal(counter.admission(msgs, { reasoning: false }), expected);
  // with reasoning: {effort: 'low'} — as the gateway sends it
  assert.equal(counter.admission([u('x'.repeat(530000))]), 132533);
});

test('dense text: provider estimate is far below real tokens (the 3030 case)', () => {
  const msgs = [u('7,'.repeat(75000))];
  assert.ok(counter.admission(msgs) < 128000);
  assert.ok(counter.prompt(msgs).total > 128000);
});
