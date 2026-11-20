// Deterministic test set for the pilot protocol (TZ 1.3.3, 5.1–5.5, 6.3) and the
// evaluation of the acceptance criteria (TZ 4.1–4.5). Synthetic, no personal data.
// Shared by the Node test runner and the demo page.

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const pick = (r, a) => a[Math.floor(r() * a.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// Synthetic contact-center / CRM texts in RU, KK, EN + code and JSON.
const POOLS = {
  ru: [
    'Клиент сообщает, что заказ не доставлен в срок и просит уточнить статус.',
    'Оператор проверил данные в CRM и подтвердил, что посылка находится на складе в Караганде.',
    'Повторная отправка запланирована на ближайший рабочий день, курьер свяжется заранее.',
    'Клиент просит перенести доставку на вечер и оставить заказ у консьержа.',
    'Компенсация за задержку оформлена и поступит на карту в течение трёх рабочих дней.',
    'По тарифу «Бизнес» входит 500 минут исходящих звонков и запись разговоров на 90 дней.',
    'Менеджер предложил демонстрацию сервиса автодозвона и отправил коммерческое предложение.',
    'Скрипт разговора обновлён: добавлен блок про возражение «дорого» и про пробный период.',
    'Сделка переведена на этап «Согласование договора», ответственный — отдел продаж Алматы.',
    'Клиент недоволен качеством связи, оператор создал заявку на проверку линии.',
  ],
  kk: [
    'Клиент тапсырыстың уақытында жеткізілмегенін айтып, мәртебесін нақтылауды сұрайды.',
    'Оператор CRM жүйесіндегі деректерді тексеріп, сәлемдеменің Қарағанды қоймасында екенін растады.',
    'Қайта жөнелту келесі жұмыс күніне жоспарланды, курьер алдын ала хабарласады.',
    'Кешіктіру үшін өтемақы рәсімделді, ол үш жұмыс күні ішінде картаға түседі.',
    'Менеджер автоқоңырау қызметінің көрсетілімін ұсынып, коммерциялық ұсыныс жіберді.',
    'Клиент байланыс сапасына көңілі толмайды, оператор желіні тексеруге өтінім жасады.',
  ],
  en: [
    'The customer reports that the order was not delivered on time and asks for a status update.',
    'The agent checked the CRM record and confirmed that the parcel is still at the Karaganda warehouse.',
    'A second delivery attempt is scheduled for the next business day; the courier will call in advance.',
    'Compensation for the delay has been issued and will reach the card within three business days.',
    'The sales manager offered a demo of the auto-dialer and sent a commercial proposal.',
    'The call script was updated with a section on the "too expensive" objection and the free trial.',
  ],
  code: [
    'public async Task<Result> SendAsync(Request req, CancellationToken ct) { var tokens = _counter.Count(req.Messages); if (tokens > _limit) return Result.TooLarge(tokens); }',
    'def route(msg): return "sales" if msg.intent in ("buy", "price") else "support"',
    'SELECT id, phone, status FROM leads WHERE created_at > now() - interval \'7 days\' ORDER BY id DESC;',
    'const reply = await gateway.chat({ messages, max_tokens: 512 }); if (reply.error) logger.warn(reply.error.code);',
  ],
  json: [
    '{"lead_id":104233,"phone":"+7 701 000 00 00","stage":"negotiation","amount":125000,"currency":"KZT"}',
    '{"call_id":"c-88812","duration_sec":312,"operator":42,"tags":["delivery","refund"],"csat":4}',
    '{"ticket":5512,"priority":"high","sla_hours":4,"history":[{"t":"2026-11-03","s":"open"},{"t":"2026-11-04","s":"pending"}]}',
  ],
};
const LANGS = ['ru', 'ru', 'ru', 'kk', 'en', 'code', 'json'];

/** Text of about `target` tokens (exact when `exact`), built from a pool. */
export function textOfTokens(tok, r, target, lang = pick(r, LANGS)) {
  const pool = POOLS[lang];
  if (target <= 0) return '';
  let text = '';
  let n = 0;
  for (let guard = 0; guard < 100000; guard++) {
    const s = (text ? ' ' : '') + pick(r, pool);
    const c = tok.count(s);
    if (n + c > target) break;
    text += s;
    n += c;
  }
  // adjust exactly with short words
  n = tok.count(text);
  const filler = lang === 'en' || lang === 'code' || lang === 'json' ? ' ok' : ' да';
  while (n < target) { text += filler; n = tok.count(text); }
  while (n > target) {
    const i = text.lastIndexOf(' ');
    text = i > 0 ? text.slice(0, i) : text.slice(0, -1);
    n = tok.count(text);
    while (n < target) { text += filler; n = tok.count(text); }
  }
  return text;
}

/** Messages whose full prompt (template included) is exactly `total` tokens. */
export function dialogOfTokens(counter, r, total, { turns = int(r, 1, 8), system = r() < 0.7, lang } = {}) {
  const { base, perMessage } = counter.model.template;
  const roles = [];
  if (system) roles.push('system');
  for (let i = 0; i < turns; i++) roles.push('user', 'assistant');
  roles.pop(); // end on a user message
  if (roles[roles.length - 1] !== 'user') roles.push('user');
  let content = total - base - perMessage * roles.length;
  while (content < roles.length && roles.length > 1) { roles.shift(); content = total - base - perMessage * roles.length; }
  const weights = roles.map(() => 0.5 + r());
  const sum = weights.reduce((a, b) => a + b, 0);
  const msgs = [];
  let left = content;
  roles.forEach((role, i) => {
    const t = i === roles.length - 1 ? left : Math.max(1, Math.floor((content * weights[i]) / sum));
    left -= t;
    msgs.push({ role, content: textOfTokens(counter.tok, r, Math.max(0, t), lang) });
  });
  // fix the rounding on the last message
  const diff = total - counter.prompt(msgs).total;
  if (diff !== 0) {
    const last = msgs[msgs.length - 1];
    last.content = textOfTokens(counter.tok, r, counter.tok.count(last.content) + diff, lang);
  }
  return msgs;
}

/** Plain Russian words: few tokens per character (the provider over-estimates such text). */
export function wordList(chars) {
  const w = ['клиент', 'заказ', 'доставка', 'оператор', 'статус', 'компенсация', 'курьер', 'склад', 'договор', 'звонок'];
  let t = '';
  for (let i = 0; t.length < chars; i++) t += w[(i * 7) % w.length] + ' ';
  return t.slice(0, chars);
}

function denseJson(r, chars) {
  let s = '[';
  let i = 0;
  while (s.length < chars) {
    s += `${i ? ',' : ''}{"id":${100000 + i},"p":"7${int(r, 100000000, 999999999)}","s":${int(r, 1, 9)},"a":${int(r, 1000, 99999)}}`;
    i++;
  }
  return s + ']';
}

/**
 * Builds the protocol cases. Each case: { id, scenario, expected, body, gateway, note }.
 * `expected`: within | near | over. `gateway` = per-case overrides (limit, mock_fault).
 */
export function buildTestSet(counter, { limit = 8192, reserve = 512, nearBand = 0.1, seed = 20261120 } = {}) {
  const r = rng(seed);
  const maxInput = limit - reserve;
  const nearFrom = Math.floor(maxInput * (1 - nearBand));
  const cases = [];
  const add = (scenario, expected, body, note, gateway = {}) =>
    cases.push({ id: `${scenario}-${String(cases.filter((c) => c.scenario === scenario).length + 1).padStart(3, '0')}`, scenario, expected, body, gateway, note });

  // 5.1 — well below the limit
  for (let i = 0; i < 120; i++) {
    const t = int(r, 80, Math.floor(nearFrom * 0.7));
    add('5.1', 'within', { messages: dialogOfTokens(counter, r, t) }, `${t} токенов`);
  }
  // 5.2 — around the limit (exact boundaries, reserve variants)
  const near = [];
  for (let i = 0; i < 12; i++) near.push([maxInput, 'near', 'ровно на лимите']);
  for (let i = 0; i < 12; i++) near.push([nearFrom + 1, 'near', 'первый токен зоны «около лимита»']);
  for (let i = 0; i < 12; i++) near.push([nearFrom, 'within', 'последний токен до зоны «около»']);
  for (let i = 0; i < 30; i++) near.push([int(r, nearFrom + 1, maxInput), 'near', 'в зоне около лимита']);
  for (let i = 0; i < 12; i++) near.push([maxInput + 1, 'over', 'на 1 токен больше лимита']);
  for (const [t, exp, note] of near) add('5.2', exp, { messages: dialogOfTokens(counter, r, t) }, `${t} токенов, ${note}`);
  for (const mt of [256, 1024, 2048]) {
    for (const [d, exp] of [[0, 'near'], [1, 'over'], [-Math.ceil((limit - mt) * nearBand) - 1, 'within']]) {
      for (let k = 0; k < 2; k++) {
        const t = limit - mt + d;
        add('5.2', exp, { messages: dialogOfTokens(counter, r, t), max_tokens: mt }, `${t} токенов при max_tokens=${mt}`);
      }
    }
  }
  // 5.3 — above the limit
  for (let i = 0; i < 30; i++) {
    const t = int(r, maxInput + 2, maxInput * 3);
    add('5.3', 'over', { messages: dialogOfTokens(counter, r, t, { turns: int(r, 6, 20) }) }, `длинная история, ${t} токенов`);
  }
  for (let i = 0; i < 20; i++) {
    const t = int(r, maxInput + 2, maxInput * 4);
    add('5.3', 'over', { messages: dialogOfTokens(counter, r, t, { turns: 1 }) }, `одно большое сообщение, ${t} токенов`);
  }
  for (let i = 0; i < 10; i++) {
    const msgs = [{ role: 'system', content: 'Проанализируй выгрузку из CRM.' }, { role: 'user', content: denseJson(r, int(r, 30000, 90000)) + '\n\nСколько лидов на этапе 3?' }];
    add('5.3', 'over', { messages: msgs }, `плотный JSON, ${counter.prompt(msgs).total} токенов`);
  }
  // 5.3 at the model window (limit = 128 000): the two provider failure modes we measured
  {
    const m1 = [{ role: 'user', content: wordList(530000) }];
    add('5.3', 'over', { messages: m1, max_tokens: 1024 }, `список русских слов, 530 000 символов: ${counter.prompt(m1).total} токенов, но оценка провайдера ${counter.admission(m1)} > 128 000 (ошибка 5021)`, { limit: 128000 });
    const m2 = [{ role: 'user', content: denseJson(r, 300000) }];
    add('5.3', 'over', { messages: m2, max_tokens: 1024 }, `плотный JSON 300 000 символов: оценка провайдера ${counter.admission(m2)}, а реально ${counter.prompt(m2).total} токенов (у провайдера — 3030 Internal Server Error)`, { limit: 128000 });
    const m3 = [{ role: 'user', content: '7,'.repeat(66000) }];
    add('5.3', 'over', { messages: m3, max_tokens: 1024 }, `«7,» × 66 000 — тот же запрос, что дал 3030 на живом Workers AI`, { limit: 128000 });
    const m4 = dialogOfTokens(counter, r, 60000, { turns: 2, lang: 'ru' });
    add('5.3', 'within', { messages: m4, max_tokens: 1024 }, `60 000 токенов при окне 128 000`, { limit: 128000 });
  }
  // 5.4 — repeating an over-limit request (non-trimmable single message): second must not reach the model
  for (let i = 0; i < 10; i++) {
    const t = int(r, maxInput + 50, maxInput * 2);
    const body = { messages: dialogOfTokens(counter, r, t, { turns: 1, system: false }) };
    add('5.4', 'over', body, `первая отправка, ${t} токенов`);
    add('5.4', 'over', structuredClone(body), 'повтор того же запроса', { repeat_of: cases[cases.length - 1].id });
  }
  // 5.5 — external API errors, separated from local overflow
  const faults = [['upstream_500', 8], ['timeout', 4], ['size_reject', 4], ['flaky', 4]];
  for (const [fault, n] of faults) {
    for (let i = 0; i < n; i++) {
      const t = int(r, 200, 3000);
      add('5.5', 'within', { messages: dialogOfTokens(counter, r, t) }, `${t} токенов, сбой провайдера: ${fault}`, { mock_fault: fault });
    }
  }
  return cases;
}

const EXPECTED_FAULT = { upstream_500: 'UPSTREAM_ERROR', timeout: 'UPSTREAM_TIMEOUT', size_reject: 'UPSTREAM_CONTEXT_REJECTED', flaky: 'ok' };

/**
 * Evaluates TZ 4.1–4.5 from the results.
 * results[i] = { case, status, body, journal (entry or null), upstreamCallsForFp? }
 */
export function evaluate(results) {
  const by = (pred) => results.filter(pred);
  const cls = (x) => x.body?.gateway?.class ?? x.body?.error?.details?.class ?? null;
  const code = (x) => (x.status === 200 ? 'ok' : x.body?.error?.code);
  const isRepeat = (x) => !!x.case.gateway?.repeat_of;
  const faulted = (x) => !!x.case.gateway?.mock_fault;

  // 4.1 requests within the limit pass unchanged and without size errors
  const inLimit = by((x) => x.case.expected !== 'over' && !faulted(x));
  const okIn = inLimit.filter((x) => x.status === 200 && x.body.gateway.forwarded === 'original');
  // 4.2 over-limit requests handled in a controlled way (strategy answer or clear 413), never 5xx
  const over = by((x) => x.case.expected === 'over');
  const controlled = over.filter((x) => (x.status === 200 && x.body.gateway.forwarded === 'modified') || (x.status === 413 && x.body.error?.code));
  // 4.3 classification vs the agreed method
  const classified = by((x) => !isRepeat(x));
  const correct = classified.filter((x) => cls(x) === x.case.expected);
  // 4.4 no uncontrolled repeats: a repeat of a REJECTED request is answered locally (0 upstream
  //     calls); a repeat of a request the strategy handled is handled again (size changed, allowed
  //     by TZ 3.4); and no over-limit request is ever forwarded unchanged
  const repeats = by(isRepeat);
  const firstOf = (x) => results.find((y) => y.case.id === x.case.gateway.repeat_of);
  const repeatOk = repeats.filter((x) => {
    const first = firstOf(x);
    if (first?.status === 200) return x.status === 200 && x.body.gateway.forwarded === 'modified';
    return x.status === 413 && x.body.error.code === 'REPEATED_OVERSIZE_REQUEST' && (x.journal ? x.journal.upstream_calls === 0 : true);
  });
  const forwardedOver = over.filter((x) => x.status === 200 && x.body.gateway.forwarded === 'original');
  // 4.5 diagnostics for every over-limit case
  const need = ['request_id', 'estimated_tokens', 'limit', 'strategy', 'result'];
  const diag = over.filter((x) => x.journal && need.every((k) => x.journal[k] !== undefined && x.journal[k] !== null || (k === 'estimated_tokens' && isRepeat(x))));
  // 5.5 external errors are reported separately from local overflow
  const faults = by(faulted);
  const faultOk = faults.filter((x) => code(x) === EXPECTED_FAULT[x.case.gateway.mock_fault] && cls(x) === 'within');
  const internal = by((x) => x.status >= 500 && x.body?.error?.code === 'GATEWAY_INTERNAL');

  const pct = (a, b) => (b ? Math.round((a / b) * 10000) / 100 : 100);
  return {
    total: results.length,
    criteria: [
      { id: '4.1', name: 'Запросы в пределах лимита проходят без изменений', need: '≥ 99%', value: pct(okIn.length, inLimit.length), detail: `${okIn.length} из ${inLimit.length}`, pass: pct(okIn.length, inLimit.length) >= 99 },
      { id: '4.2', name: 'Запросы выше лимита обработаны контролируемо', need: '100%', value: pct(controlled.length, over.length), detail: `${controlled.length} из ${over.length}`, pass: controlled.length === over.length },
      { id: '4.3', name: 'Классификация относительно лимита верна', need: '≥ 99%', value: pct(correct.length, classified.length), detail: `${correct.length} из ${classified.length}`, pass: pct(correct.length, classified.length) >= 99 },
      { id: '4.4', name: 'Нет повторной отправки превышенного запроса', need: '0 нарушений', value: repeats.length - repeatOk.length + forwardedOver.length, detail: `повторов заблокировано ${repeatOk.length} из ${repeats.length}; превышенных отправлено без изменений: ${forwardedOver.length}`, pass: repeatOk.length === repeats.length && forwardedOver.length === 0 },
      { id: '4.5', name: 'Диагностика в журнале по каждому превышению', need: '100%', value: pct(diag.length, over.length), detail: `${diag.length} из ${over.length}`, pass: diag.length === over.length },
      { id: '5.5', name: 'Ошибки внешнего API отделены от превышения', need: '100%', value: pct(faultOk.length, faults.length), detail: `${faultOk.length} из ${faults.length}`, pass: faultOk.length === faults.length },
      { id: '—', name: 'Необработанные падения шлюза (GATEWAY_INTERNAL)', need: '0', value: internal.length, detail: `${internal.length}`, pass: internal.length === 0 },
    ],
    failures: results
      .filter((x) => {
        if (isRepeat(x)) return !repeatOk.includes(x);
        if (faulted(x)) return !faultOk.includes(x);
        if (cls(x) !== x.case.expected) return true;
        if (x.case.expected === 'over') return !controlled.includes(x);
        return !okIn.includes(x);
      })
      .map((x) => ({ id: x.case.id, expected: x.case.expected, got: cls(x), status: x.status, code: code(x), note: x.case.note })),
  };
}
