// Converts the official o200k_base.tiktoken (base64 token + rank per line) into a
// compact binary: for rank 0..N-1 in order — [length:u8][token bytes].
// The source file is published by OpenAI at
// https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken
// sha256 446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d
//
//   node tools/build-vocab.mjs <path to o200k_base.tiktoken>
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = '446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d';
const src = fs.readFileSync(process.argv[2]);
const sha = crypto.createHash('sha256').update(src).digest('hex');
if (sha !== SHA) throw new Error('unexpected o200k_base.tiktoken checksum ' + sha);

const lines = src.toString('utf8').split('\n').filter(Boolean);
const tokens = [];
for (const line of lines) {
  const [b64, rank] = line.split(' ');
  tokens[+rank] = Buffer.from(b64, 'base64');
}
const parts = [];
for (let r = 0; r < tokens.length; r++) {
  const t = tokens[r];
  if (!t) throw new Error('gap at rank ' + r);
  if (t.length > 255) throw new Error('token too long at rank ' + r);
  parts.push(Buffer.from([t.length]), t);
}
const out = Buffer.concat(parts);
const dst = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tokenizer', 'o200k_base.bin');
fs.writeFileSync(dst, out);
console.log(`${tokens.length} tokens -> ${dst} (${out.length} bytes)`);
