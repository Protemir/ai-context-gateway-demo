// Context size of a chat request for one specific model: exact tokenizer for the
// message contents + calibrated chat-template overhead + the provider's own admission estimate.

const utf8 = new TextEncoder();

/** Text of an OpenAI-style message content (string or array of parts). */
export function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text || '' : '')).join('');
  }
  return String(content);
}

export function makeCounter(tok, model) {
  const { base, perMessage } = model.template;
  const adm = model.providerAdmission;

  const message = (m) => tok.count(contentText(m.content));

  return {
    model,
    tok,
    message,
    /** Exact prompt size: { perMessage: [...], content, overhead, total } */
    prompt(messages) {
      const per = messages.map(message);
      const content = per.reduce((a, b) => a + b, 0);
      const overhead = base + perMessage * messages.length;
      return { perMessage: per, content, overhead, total: content + overhead };
    },
    /** Upper bound without tokenizing: a token is at least one UTF-8 byte. */
    upperBound(messages) {
      let bytes = 0;
      for (const m of messages) bytes += utf8.encode(contentText(m.content)).length;
      return bytes + base + perMessage * messages.length;
    },
    /** Tokens that one extra message with this text adds to a prompt. */
    messageCost(text) {
      return tok.count(text) + perMessage;
    },
    /** The provider's character-based admission estimate (Workers AI error 5021). */
    admission(messages, { reasoning = true } = {}) {
      if (!adm) return 0;
      let chars = 0;
      for (const m of messages) chars += contentText(m.content).length;
      return Math.ceil((chars + adm.base + adm.perMessage * (messages.length - 1) + (reasoning ? adm.reasoningChars || 0 : 0)) / adm.divisor);
    },
  };
}
