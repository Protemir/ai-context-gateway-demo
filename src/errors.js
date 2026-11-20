// Controlled results of the gateway. Every failure the caller can see has an
// HTTP status, a stable machine code and a human message (RU + EN).

export class GatewayError extends Error {
  constructor(status, code, message, messageEn, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.messageEn = messageEn;
    this.details = details;
  }
}

/** Error raised by a model provider adapter. kind: size | error | timeout */
export class ProviderError extends Error {
  constructor(kind, message, raw) {
    super(message);
    this.kind = kind;
    this.raw = raw;
  }
}

const fmt = (n) => (n == null ? '?' : Number(n).toLocaleString('ru-RU'));
/** 1 токен, 2 токена, 5 токенов */
export function tokens(n) {
  const a = Math.abs(n) % 100, b = a % 10;
  const w = a > 10 && a < 20 ? 'токенов' : b === 1 ? 'токен' : b >= 2 && b <= 4 ? 'токена' : 'токенов';
  return `${fmt(n)} ${w}`;
}

export const errors = {
  overLimit: (m) =>
    new GatewayError(
      413,
      'CONTEXT_LIMIT_EXCEEDED',
      `Запрос слишком длинный для модели: ${tokens(m.tokens)} при допустимых ${fmt(m.maxInput)} (лимит ${fmt(m.limit)}, резерв на ответ ${fmt(m.reserve)}). Сократите текст или разбейте его на части.`,
      `Request is too long for the model: ${m.tokens} tokens, ${m.maxInput} allowed (limit ${m.limit}, answer reserve ${m.reserve}).`,
    ),
  overAdmission: (m, window) =>
    new GatewayError(
      413,
      'CONTEXT_LIMIT_EXCEEDED',
      `Провайдер не примет запрос: по его оценке ${tokens(m.admission)} при окне модели ${fmt(window)}. Сократите текст.`,
      `The provider will refuse the request: its estimate is ${m.admission} tokens, model window ${window}.`,
    ),
  cannotFit: (strategy, m, why) =>
    new GatewayError(
      413,
      'CONTEXT_LIMIT_EXCEEDED_AFTER_STRATEGY',
      `Стратегия «${strategy}» не смогла уложить запрос в ${tokens(m.maxInput)}: ${why}. Сократите последнее сообщение.`,
      `Strategy "${strategy}" could not fit the request into ${m.maxInput} tokens: ${why}.`,
    ),
  tooManyParts: (parts, max) =>
    new GatewayError(
      413,
      'CONTEXT_TOO_LARGE_FOR_SPLIT',
      `Документ слишком большой даже для разбиения: нужно ${parts} частей, допускается ${max}.`,
      `The document is too large to split: ${parts} parts needed, ${max} allowed.`,
    ),
  repeat: (info) =>
    new GatewayError(
      413,
      'REPEATED_OVERSIZE_REQUEST',
      'Этот же запрос уже был отклонён из-за превышения лимита контекста. Повторная отправка в модель без изменения запроса не выполняется.',
      'This exact request was already rejected for exceeding the context limit; it is not resent to the model unchanged.',
      info,
    ),
  upstreamSize: (msg) =>
    new GatewayError(
      502,
      'UPSTREAM_CONTEXT_REJECTED',
      'Модельный API отклонил запрос из-за размера контекста. Запрос не повторяется без изменения.',
      'The model API rejected the request because of its context size; it is not retried unchanged.',
      { upstream: msg },
    ),
  upstream: (msg) =>
    new GatewayError(502, 'UPSTREAM_ERROR', 'Модельный API вернул ошибку, не связанную с размером запроса. Попробуйте позже.', 'The model API returned an error unrelated to the request size.', { upstream: msg }),
  timeout: () => new GatewayError(504, 'UPSTREAM_TIMEOUT', 'Модельный API не ответил вовремя.', 'The model API timed out.'),
  bad: (why) => new GatewayError(400, 'BAD_REQUEST', `Некорректный запрос: ${why}.`, `Bad request: ${why}.`),
  budget: () =>
    new GatewayError(429, 'DEMO_BUDGET_EXHAUSTED', 'Суточный бюджет живых вызовов модели в демо исчерпан. Режим «эмулятор провайдера» работает без ограничений.', 'The daily budget of live model calls in this demo is used up; the provider emulator still works.'),
  callCap: (est) =>
    new GatewayError(429, 'DEMO_CALL_TOO_EXPENSIVE', `В живом режиме демо один вызов модели ограничен ~16 000 токенов (этот стоил бы ~${est} нейронов). Шлюз запрос пропустил бы; используйте эмулятор провайдера.`, 'In the live demo one model call is capped at ~16k tokens; use the provider emulator.'),
  rate: () => new GatewayError(429, 'DEMO_RATE_LIMIT', 'Слишком много запросов с вашего адреса за сутки.', 'Too many requests from your address today.'),
  internal: () => new GatewayError(500, 'GATEWAY_INTERNAL', 'Внутренняя ошибка шлюза. Запрос записан в журнал.', 'Internal gateway error; the request is logged.'),
};
