import test from 'node:test';
import assert from 'node:assert/strict';
import { tok } from './helpers.mjs';
import { splitByTokens } from '../src/tokenizer/bpe.js';
import { rng } from '../src/testset.js';

test('o200k reference vectors (tiktoken)', () => {
  assert.deepEqual(tok.encode('hello world'), [24912, 2375]);
  assert.deepEqual(tok.encode('tiktoken is great!'), [83, 8251, 2488, 382, 2212, 0]);
  assert.equal(tok.size, 199998);
});

test('encode/decode round trip on mixed text', () => {
  for (const s of ['Привет, мир!', 'Сәлем, әлем! Қазақстан', '😀 emoji 🚀', 'a\r\n\tb   c', '{"a":[1,2,3]}', '']) {
    assert.equal(tok.decode(tok.encode(s)), s);
  }
});

test('heap merge equals the reference O(n^2) merge', () => {
  const r = rng(7);
  const alpha = 'aабвс  \n1é😀-_/xyzЖ';
  for (let k = 0; k < 2000; k++) {
    let s = '';
    const L = 1 + Math.floor(r() * 150);
    for (let i = 0; i < L; i++) s += alpha[Math.floor(r() * alpha.length)];
    const b = new TextEncoder().encode(s);
    assert.deepEqual(tok.mergeHeap(b), tok.merge(b), s);
  }
});

test('long whitespace runs are fast (heap path)', () => {
  const t = performance.now();
  assert.ok(tok.count(' '.repeat(20000) + 'a') > 0);
  assert.ok(performance.now() - t < 2000);
});

test('special tokens count as one only in template markup', () => {
  assert.equal(tok.countWithSpecials('<|start|>user<|message|>x<|end|>'), 5);
  assert.ok(tok.count('<|end|>') > 1);
});

test('splitByTokens: every chunk fits, nothing lost', () => {
  const text = 'Оператор проверил заказ 48213. '.repeat(400) + 'x'.repeat(5000);
  const chunks = splitByTokens(tok, text, 500);
  assert.equal(chunks.join(''), text);
  for (const c of chunks) assert.ok(tok.count(c) <= 500);
});
