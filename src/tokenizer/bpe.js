// tiktoken-compatible byte-level BPE. Used for o200k_base / o200k_harmony —
// the tokenizer of gpt-oss-20b/120b and of the GPT-4o / GPT-4.1 / GPT-5 family.
//
// The vocabulary comes as a compact binary (see tools/build-vocab.mjs):
// for rank 0..N-1 — [length:u8][token bytes]. The rank of a token is also its
// merge priority, exactly as in tiktoken.

// o200k pre-tokenizer (tiktoken `o200k_base` pat_str). `(?i:...)` is spelled out
// so the regex works in every JS runtime.
const CONTRACTION = "(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])?";
const O200K_PATTERN = new RegExp(
  [
    `[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]*[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]+${CONTRACTION}`,
    `[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]+[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]*${CONTRACTION}`,
    '\\p{N}{1,3}',
    ' ?[^\\s\\p{L}\\p{N}]+[\\r\\n/]*',
    '\\s*[\\r\\n]+',
    '\\s+(?!\\S)',
    '\\s+',
  ].join('|'),
  'gu',
);

// Special tokens of o200k_harmony (gpt-oss chat format).
export const HARMONY_SPECIALS = {
  '<|startoftext|>': 199998,
  '<|endoftext|>': 199999,
  '<|return|>': 200002,
  '<|constrain|>': 200003,
  '<|channel|>': 200005,
  '<|start|>': 200006,
  '<|end|>': 200007,
  '<|message|>': 200008,
  '<|call|>': 200012,
};

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

// Latin-1 style key: one char per byte. Collision-free and cheap to slice.
function bytesToKey(bytes, start = 0, end = bytes.length) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function keyToBytes(key) {
  const b = new Uint8Array(key.length);
  for (let i = 0; i < key.length; i++) b[i] = key.charCodeAt(i);
  return b;
}

// Small binary min-heap of [rank, pos, version] (pos breaks ties -> leftmost first).
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  less(x, y) { return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]); }
  push(v) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

export class BpeTokenizer {
  /**
   * @param {Uint8Array} vocab compact vocabulary
   * @param {Record<string, number>} specials special tokens recognised in templates
   */
  constructor(vocab, specials = {}) {
    // One big latin-1 string; every token key is a cheap slice of it.
    let all = '';
    for (let i = 0; i < vocab.length; i += 8192) {
      all += String.fromCharCode.apply(null, vocab.subarray(i, Math.min(i + 8192, vocab.length)));
    }
    this.ranks = new Map();
    this.decoder = [];
    let rank = 0;
    for (let i = 0; i < vocab.length; ) {
      const len = vocab[i++];
      const key = all.slice(i, i + len);
      this.ranks.set(key, rank);
      this.decoder.push(key);
      rank++;
      i += len;
    }
    this.size = rank;
    this.specials = specials;
    const names = Object.keys(specials).sort((a, b) => b.length - a.length);
    this.specialRe = names.length
      ? new RegExp(names.map((n) => n.replace(/[|<>]/g, (c) => '\\' + c)).join('|'), 'g')
      : null;
    this.cache = new Map();
  }

  /** Token count of ordinary text (special-token strings are treated as plain text). */
  count(text) {
    let n = 0;
    for (const w of this.words(text)) n += this.word(w).length;
    return n;
  }

  /** Token count where special-token markup (e.g. `<|start|>`) counts as one token each. */
  countWithSpecials(text) {
    if (!this.specialRe) return this.count(text);
    let n = 0;
    let last = 0;
    for (const m of text.matchAll(this.specialRe)) {
      n += this.count(text.slice(last, m.index)) + 1;
      last = m.index + m[0].length;
    }
    return n + this.count(text.slice(last));
  }

  /** Encode ordinary text to token ids. */
  encode(text) {
    const ids = [];
    for (const w of this.words(text)) for (const key of this.word(w)) ids.push(this.ranks.get(key));
    return ids;
  }

  /** Decode token ids back to text. */
  decode(ids) {
    const parts = ids.map((id) => keyToBytes(this.decoder[id]));
    const len = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return utf8d.decode(out);
  }

  /** Pre-tokenized words (tiktoken regex split). */
  *words(text) {
    if (!text) return;
    for (const m of text.matchAll(O200K_PATTERN)) yield m[0];
  }

  /** Token keys for one pre-tokenized word (cached). */
  word(w) {
    let hit = this.cache.get(w);
    if (hit) return hit;
    const bytes = utf8.encode(w);
    const whole = bytesToKey(bytes);
    hit = this.ranks.has(whole) ? [whole] : bytes.length > 64 ? this.mergeHeap(bytes) : this.merge(bytes);
    if (this.cache.size > 50000) this.cache.clear();
    this.cache.set(w, hit);
    return hit;
  }

  rankRange(bytes, a, b) {
    const r = this.ranks.get(bytesToKey(bytes, a, b));
    return r === undefined ? Infinity : r;
  }

  // tiktoken `_byte_pair_merge`: repeatedly merge the adjacent pair whose
  // concatenation has the lowest rank (leftmost on ties). O(n^2), for short words.
  merge(bytes) {
    const n = bytes.length;
    if (n === 1) return [bytesToKey(bytes)];
    const starts = [];
    for (let i = 0; i <= n; i++) starts.push(i);
    const rankOf = (i) => (i + 2 < starts.length ? this.rankRange(bytes, starts[i], starts[i + 2]) : Infinity);
    const pairRanks = [];
    for (let i = 0; i < starts.length - 1; i++) pairRanks.push(rankOf(i));
    while (starts.length > 2) {
      let min = Infinity;
      let at = -1;
      for (let i = 0; i < pairRanks.length - 1; i++) {
        if (pairRanks[i] < min) { min = pairRanks[i]; at = i; }
      }
      if (at < 0) break;
      starts.splice(at + 1, 1);
      pairRanks.splice(at + 1, 1);
      pairRanks[at] = rankOf(at);
      if (at > 0) pairRanks[at - 1] = rankOf(at - 1);
    }
    const out = [];
    for (let i = 0; i < starts.length - 1; i++) out.push(bytesToKey(bytes, starts[i], starts[i + 1]));
    return out;
  }

  // Same merge order with a linked list + heap: O(n log n) for long words
  // (long runs of spaces, base64, minified code).
  mergeHeap(bytes) {
    const n = bytes.length;
    const next = new Int32Array(n + 1);
    const prev = new Int32Array(n + 1);
    const ver = new Int32Array(n + 1);
    for (let i = 0; i <= n; i++) { next[i] = i + 1; prev[i] = i - 1; }
    // a part starts at byte i and ends at next[i]; a pair (i, next[i]) ends at next[next[i]]
    const heap = new Heap();
    const pushPair = (i) => {
      if (i < 0 || next[i] >= n) return;
      const r = this.rankRange(bytes, i, next[next[i]]);
      if (r !== Infinity) heap.push([r, i, ver[i]]);
    };
    for (let i = 0; i < n - 1; i++) pushPair(i);
    while (heap.size) {
      const [, i, v] = heap.pop();
      if (v !== ver[i] || next[i] >= n) continue; // stale
      const j = next[i];
      next[i] = next[j];
      if (next[j] <= n) prev[next[j]] = i;
      ver[i]++;
      ver[j]++;
      if (prev[i] >= 0) ver[prev[i]]++;
      pushPair(i);
      if (prev[i] >= 0) pushPair(prev[i]);
    }
    const out = [];
    for (let i = 0; i < n; i = next[i]) out.push(bytesToKey(bytes, i, next[i]));
    return out;
  }
}

/**
 * Splits `text` into chunks of at most `maxTokens` tokens each. Cuts on
 * pre-tokenizer word boundaries, so chunks never break a UTF-8 character and
 * their counts add up exactly to the count of the whole text.
 */
export function splitByTokens(tok, text, maxTokens) {
  const chunks = [];
  let cur = '';
  let curN = 0;
  for (const w of tok.words(text)) {
    const keys = tok.word(w);
    if (keys.length > maxTokens) {
      // a single giant word (no spaces): cut it at token boundaries
      if (cur) { chunks.push(cur); cur = ''; curN = 0; }
      for (let i = 0; i < keys.length; i += maxTokens) {
        chunks.push(tok.decode(keys.slice(i, i + maxTokens).map((k) => tok.ranks.get(k))));
      }
      continue;
    }
    if (curN + keys.length > maxTokens) { chunks.push(cur); cur = ''; curN = 0; }
    cur += w;
    curN += keys.length;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
