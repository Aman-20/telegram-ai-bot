import { PROVIDERS, providerKey } from "../config/providers.js";
import { ProviderError, classifyError } from "./errors.js";
import * as gemini from "./gemini.js";
import * as openai from "./openai.js";
import * as anthropic from "./anthropic.js";

const ADAPTERS = {
  gemini,
  openai,
  "openai-compatible": openai,
  anthropic,
};

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("TIMEOUT:provider")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function run(fn, model, opts) {
  const ctx = { provider: model.provider, model: model.model };
  const provider = PROVIDERS[model.provider];
  if (!provider) throw new ProviderError("NOT_FOUND", `Unknown provider "${model.provider}"`, ctx);

  const apiKey = providerKey(model.provider);
  if (!apiKey) throw new ProviderError("NO_KEY", `No API key set for provider "${model.provider}"`, ctx);

  const timeoutMs = opts.timeoutMs || 90000;
  try {
    return await withTimeout(
      ADAPTERS[provider.type][fn]({
        ...opts, model, provider, providerName: model.provider, apiKey, timeoutMs,
      }),
      timeoutMs
    );
  } catch (err) {
    throw classifyError(err, ctx);
  }
}

// opts: { system?, prompt, maxTokens, timeoutMs }
// returns: { reply, truncated, totalTokens }  — or throws ProviderError
export const generate = (model, opts) => run("generate", model, opts);

// opts: { system?, prompt, base64Image, mimeType, maxTokens, timeoutMs }
export const generateWithImage = (model, opts) => run("generateWithImage", model, opts);
