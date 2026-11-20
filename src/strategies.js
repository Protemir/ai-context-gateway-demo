// Overflow strategies (TZ 3.3). One is fixed in the config before the tests;
// all of them return either messages that fit, a final answer, or a GatewayError.
import { errors } from './errors.js';
import { contentText } from './counter.js';
import { splitByTokens } from './tokenizer/bpe.js';

export const STRATEGIES = ['reject', 'trim_history', 'summarize', 'split'];

const SUMMARIZER_PROMPT =
  'Ты сжимаешь раннюю часть диалога для другой модели. Перескажи её по-русски в 3–6 предложениях. ' +
  'Обязательно сохрани номера заказов, суммы, даты, адреса, имена и все договорённости. Без вступлений.';

/** Split a dialog into: leading system messages, droppable middle turns, protected tail (last user message onward). */
export function partition(messages) {
  let h = 0;
  while (h < messages.length && messages[h].role === 'system') h++;
  let lastUser = -1;
  for (let i = messages.length - 1; i >= h; i--) if (messages[i].role === 'user') { lastUser = i; break; }
  if (lastUser < 0) lastUser = messages.length - 1;
  const head = messages.slice(0, h);
  const middle = messages.slice(h, Math.max(h, lastUser));
  const tail = messages.slice(Math.max(h, lastUser));
  // group the middle into turns: a turn starts at a user message
  const turns = [];
  for (const m of middle) {
    if (m.role === 'user' || !turns.length) turns.push([m]);
    else turns[turns.length - 1].push(m);
  }
  return { head, turns, tail };
}

const total = (counter, msgs) => counter.prompt(msgs).total;

/** Keep the beginning and the end of a text so that it has at most `maxTokens` tokens. */
export function truncateMiddle(tok, text, maxTokens, markerFor = (n) => `\n[…шлюз опустил ${n} токенов…]\n`) {
  const words = [...tok.words(text)].map((w) => ({ w, n: tok.word(w).length }));
  const all = words.reduce((a, x) => a + x.n, 0);
  if (all <= maxTokens) return { text, removed: 0 };
  const markerCost = tok.count(markerFor(all)) + 1;
  const budget = Math.max(0, maxTokens - markerCost);
  const headBudget = Math.floor(budget * 0.7);
  let hn = 0, hi = 0;
  while (hi < words.length && hn + words[hi].n <= headBudget) hn += words[hi++].n;
  let tn = 0, ti = words.length;
  while (ti > hi && tn + words[ti - 1].n <= budget - hn) tn += words[--ti].n;
  const removed = all - hn - tn;
  const out = words.slice(0, hi).map((x) => x.w).join('') + markerFor(removed) + words.slice(ti).map((x) => x.w).join('');
  return { text: out, removed };
}

const note = (n) => ({ role: 'system', content: `[Шлюз: ${n} ранних сообщений диалога опущены, чтобы уложиться в лимит контекста модели.]` });

/** Drop the oldest turns until the request fits. */
export function trimHistory(messages, counter, m, cfg) {
  const { head, turns, tail } = partition(messages);
  let kept = turns.slice();
  let dropped = 0;
  const build = () => [...head, ...(dropped && cfg.trim.addNote ? [note(dropped)] : []), ...kept.flat(), ...tail];
  let msgs = build();
  while (total(counter, msgs) > m.maxInput && kept.length) {
    dropped += kept.shift().length;
    msgs = build();
  }
  let truncated = 0;
  if (total(counter, msgs) > m.maxInput) {
    if (!cfg.trim.truncateLastMessage) throw errors.cannotFit('trim_history', m, 'последнее сообщение само по себе больше лимита');
    // cut the middle of the largest tail message
    const idx = msgs.length - tail.length + tail.reduce((best, x, i, a) => (counter.message(x) > counter.message(a[best]) ? i : best), 0);
    const others = total(counter, msgs) - counter.message(msgs[idx]);
    let room = m.maxInput - others;
    for (let attempt = 0; attempt < 5 && room > 0; attempt++) {
      const t = truncateMiddle(counter.tok, contentText(msgs[idx].content), room);
      const cand = msgs.slice();
      cand[idx] = { ...msgs[idx], content: t.text };
      if (total(counter, cand) <= m.maxInput) { msgs = cand; truncated = t.removed; break; }
      room -= 8;
    }
    if (!truncated) throw errors.cannotFit('trim_history', m, 'не удалось сократить последнее сообщение');
  }
  if (counter.admission(msgs) > counter.model.contextWindow) throw errors.cannotFit('trim_history', m, 'превышена оценка допуска провайдера');
  return { messages: msgs, actions: { dropped_messages: dropped, truncated_tokens: truncated } };
}

function transcript(msgs) {
  const who = { user: 'Пользователь', assistant: 'Ассистент', system: 'Система', tool: 'Инструмент' };
  return msgs.map((x) => `${who[x.role] || x.role}: ${contentText(x.content)}`).join('\n');
}

/** Replace the oldest turns with a model-written summary; keep the most recent turns verbatim. */
export async function summarize(messages, counter, m, cfg, call) {
  const { head, turns, tail } = partition(messages);
  if (!turns.length) return trimHistory(messages, counter, m, cfg); // nothing to summarize: same as trim
  const S = cfg.summarize.maxSummaryTokens;
  const summaryMsg = (text) => ({ role: 'system', content: `Краткое содержание ранней части диалога (сделано шлюзом): ${text}` });
  const placeholder = summaryMsg('x'.repeat(1));
  const budgetForRecent = m.maxInput - total(counter, [...head, placeholder, ...tail]) - S;
  // keep as many recent turns as fit next to the summary
  let keep = 0;
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const c = turns[i].reduce((a, x) => a + counter.message(x) + counter.model.template.perMessage, 0);
    if (used + c > budgetForRecent) break;
    used += c;
    keep++;
  }
  const old = turns.slice(0, turns.length - keep).flat();
  const recent = turns.slice(turns.length - keep).flat();
  if (!old.length) return trimHistory(messages, counter, m, cfg);

  // the summarizer call has the same limit; summarize in chunks if needed
  const sumReserve = S + 300; // gpt-oss spends part of max_tokens on reasoning
  const wrapper = total(counter, [{ role: 'system', content: SUMMARIZER_PROMPT }, { role: 'user', content: '' }]);
  const chunkBudget = m.limit - sumReserve - wrapper - 16;
  if (chunkBudget < 200) throw errors.cannotFit('summarize', m, 'лимит слишком мал для вызова суммаризации');
  const chunks = splitByTokens(counter.tok, transcript(old), chunkBudget);
  const partial = [];
  let calls = 0;
  for (const ch of chunks) {
    const r = await call([{ role: 'system', content: SUMMARIZER_PROMPT }, { role: 'user', content: ch }], sumReserve, 'summarize');
    calls++;
    partial.push(r.text.trim());
  }
  let summary = partial.join(' ');
  if (counter.tok.count(summary) > S) summary = truncateMiddle(counter.tok, summary, S, () => ' … ').text;
  let msgs = [...head, summaryMsg(summary), ...recent, ...tail];
  if (total(counter, msgs) > m.maxInput) {
    // the model wrote more than expected: fall back to trimming the rest
    const r = trimHistory(msgs, counter, m, cfg);
    return { messages: r.messages, actions: { summarized_messages: old.length, summary_calls: calls, ...r.actions } };
  }
  return { messages: msgs, actions: { summarized_messages: old.length, summary_calls: calls } };
}

/** Separate the task (short last paragraph) from the document in a big user message. */
export function splitTask(tok, text) {
  const i = text.lastIndexOf('\n\n');
  if (i > 0) {
    const q = text.slice(i + 2).trim();
    if (q && tok.count(q) <= 300) return { question: q, document: text.slice(0, i) };
  }
  return { question: 'Выполни запрос пользователя по этому фрагменту.', document: text };
}

/** Map-reduce over a huge last message: answer per part, then combine. */
export async function split(messages, counter, m, cfg, call, reserve) {
  const { head, turns, tail } = partition(messages);
  const last = tail[tail.length - 1];
  const context = [...head, ...turns.flat(), ...tail.slice(0, -1)];
  const ctxTokens = total(counter, context) - counter.model.template.base; // without the fixed base
  const A = cfg.split.answerTokens;
  const { question, document } = splitTask(counter.tok, contentText(last.content));
  const wrap = (k, n, part) => `Фрагмент ${k} из ${n} большого документа:\n"""\n${part}\n"""\n\nЗадача: ${question}\nОтветь только по этому фрагменту. Если в нём нет нужного, ответь одной фразой: «во фрагменте ${k} нет данных».`;
  const wrapCost = total(counter, [{ role: 'user', content: wrap(99, 99, '') }]);
  const partBudget = m.limit - A - ctxTokens - wrapCost - 16;
  if (partBudget < 200) throw errors.cannotFit('split', m, 'история и системные сообщения занимают почти весь лимит');
  const parts = splitByTokens(counter.tok, document, partBudget);
  if (parts.length > cfg.split.maxParts) throw errors.tooManyParts(parts.length, cfg.split.maxParts);
  const answers = [];
  for (let k = 0; k < parts.length; k++) {
    const r = await call([...context, { role: 'user', content: wrap(k + 1, parts.length, parts[k]) }], A, 'split_map');
    answers.push(r.text.trim() || `(пустой ответ по фрагменту ${k + 1})`);
  }
  let joined = answers.map((a, i) => `[${i + 1}] ${a}`).join('\n\n');
  const reduceMsg = (body) => ({ role: 'user', content: `Ответы по ${parts.length} частям документа:\n\n${body}\n\nЗадача: ${question}\nСобери из них один итоговый ответ, без упоминания частей.` });
  let final = [...context, reduceMsg(joined)];
  if (total(counter, final) > m.maxInput) {
    const room = m.maxInput - total(counter, [...context, reduceMsg('')]);
    joined = truncateMiddle(counter.tok, joined, Math.max(50, room)).text;
    final = [...context, reduceMsg(joined)];
  }
  const r = await call(final, reserve, 'split_reduce');
  return { answer: r, actions: { parts: parts.length, map_calls: parts.length, empty_part_answers: answers.filter((x) => x.startsWith('(пустой ответ')).length } };
}
