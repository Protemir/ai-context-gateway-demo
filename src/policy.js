// Threshold decision (TZ 3.2): compare the measured size with the limit of the
// chosen model, keeping a reserve for the answer.

export const CLASS = { WITHIN: 'within', NEAR: 'near', OVER: 'over' };

/**
 * @returns {{
 *   limit:number, reserve:number, maxInput:number, nearFrom:number,
 *   tokens:number|null, upperBound:number|null, method:'exact'|'upper_bound',
 *   perMessage:number[]|null, admission:number, cls:string, reason:string|null
 * }}
 */
export function measure(counter, messages, { limit, reserve, nearBand, fastPath }) {
  const model = counter.model;
  const maxInput = limit - reserve;
  const nearFrom = Math.floor(maxInput * (1 - nearBand));
  const admission = counter.admission(messages);
  const admissionOk = !model.providerAdmission || admission <= model.contextWindow;

  const base = { limit, reserve, maxInput, nearFrom, admission };

  if (fastPath && admissionOk) {
    const ub = counter.upperBound(messages);
    if (ub <= nearFrom) {
      return { ...base, tokens: null, upperBound: ub, method: 'upper_bound', perMessage: null, cls: CLASS.WITHIN, reason: null };
    }
  }
  const p = counter.prompt(messages);
  let cls = CLASS.WITHIN;
  let reason = null;
  if (p.total > maxInput) { cls = CLASS.OVER; reason = 'tokens'; }
  else if (!admissionOk) { cls = CLASS.OVER; reason = 'provider_admission'; }
  else if (p.total > nearFrom) cls = CLASS.NEAR;
  return { ...base, tokens: p.total, upperBound: null, method: 'exact', perMessage: p.perMessage, cls, reason };
}

/** Does a (possibly transformed) request fit? */
export function fits(counter, messages, maxInput) {
  const total = counter.prompt(messages).total;
  const adm = counter.model.providerAdmission ? counter.admission(messages) <= counter.model.contextWindow : true;
  return { ok: total <= maxInput && adm, total };
}
