// ============================================================
//  Normalised provider errors
//  Codes: HIGH_DEMAND | TIMEOUT | NETWORK | AUTH | NOT_FOUND | NO_KEY
//         BLOCKED | EMPTY | BAD_REQUEST | UNKNOWN
// ============================================================
export class ProviderError extends Error {
  constructor(code, message, meta = {}) {
    super(message || code);
    this.name = "ProviderError";
    this.code = code;
    this.status = meta.status;
    this.provider = meta.provider;
    this.model = meta.model;
  }
}

export function classifyError(err, ctx = {}) {
  if (err instanceof ProviderError) {
    err.provider ??= ctx.provider;
    err.model ??= ctx.model;
    return err;
  }

  const msg = String(err?.message || err || "");
  const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status) || undefined;
  const name = String(err?.name || "");
  const code = String(err?.code || "");
  const make = (c) => new ProviderError(c, msg, { ...ctx, status });

  if (msg.startsWith("TIMEOUT") || /Timeout/i.test(name) || name === "AbortError" || code === "ETIMEDOUT")
    return make("TIMEOUT");

  if (status === 401 || status === 403 || /api[ _-]?key (is )?(not valid|invalid)|API_KEY_INVALID|unauthori[sz]ed|permission denied|invalid x-api-key/i.test(msg))
    return make("AUTH");

  if (status === 404 || /model.{0,60}(not found|does not exist)|not found for API version/i.test(msg))
    return make("NOT_FOUND");

  if (status === 429 || status === 529 || (status && status >= 500) ||
    /overloaded|high demand|service unavailable|rate.?limit|quota|resource.?exhausted|try again later/i.test(msg))
    return make("HIGH_DEMAND");

  if (status === 400) return make("BAD_REQUEST");

  if (/^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE)$/.test(code) || name === "APIConnectionError" ||
    /fetch failed|socket hang up|connection error|network/i.test(msg) || err?.errors?.length)
    return make("NETWORK");

  return make("UNKNOWN");
}
