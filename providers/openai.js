import OpenAI from "openai";
import { ProviderError } from "./errors.js";

// Handles both the official OpenAI API and any OpenAI-compatible service (Groq, OpenRouter, ...)
const clients = new Map();
function client({ providerName, provider, apiKey }) {
  const k = `${providerName}:${apiKey.slice(-8)}`;
  let c = clients.get(k);
  if (!c) {
    c = new OpenAI({ apiKey, baseURL: provider.baseURL, maxRetries: 1 });
    clients.set(k, c);
  }
  return c;
}

// Official OpenAI wants max_completion_tokens; most compatible services still use max_tokens
const tokenParam = (provider, n) =>
  provider.type === "openai" ? { max_completion_tokens: n } : { max_tokens: n };

function extract(result) {
  const choice = result?.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  if (!text.trim()) {
    throw new ProviderError(
      choice?.finish_reason === "content_filter" ? "BLOCKED" : "EMPTY",
      `Provider returned no text (finish_reason=${choice?.finish_reason || "none"}; the model may have used its whole token budget on reasoning)`
    );
  }
  return {
    reply: text,
    truncated: choice.finish_reason === "length",
    totalTokens: result.usage?.total_tokens,
  };
}

export async function generate(opts) {
  const { model, provider, system, prompt, maxTokens, timeoutMs } = opts;
  const messages = [
    { role: "system", content: system || "You are a helpful assistant." },
    { role: "user", content: prompt },
  ];
  const result = await client(opts).chat.completions.create(
    { model: model.model, messages, ...tokenParam(provider, maxTokens) },
    { timeout: timeoutMs }
  );
  return extract(result);
}

export async function generateWithImage(opts) {
  const { model, provider, system, prompt, maxTokens, timeoutMs, base64Image, mimeType } = opts;
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } },
      ],
    },
  ];
  const result = await client(opts).chat.completions.create(
    { model: model.model, messages, ...tokenParam(provider, maxTokens) },
    { timeout: timeoutMs }
  );
  return extract(result);
}
