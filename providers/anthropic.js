import Anthropic from "@anthropic-ai/sdk";
import { ProviderError } from "./errors.js";

const clients = new Map();
function client(apiKey) {
  let c = clients.get(apiKey);
  if (!c) { c = new Anthropic({ apiKey, maxRetries: 1 }); clients.set(apiKey, c); }
  return c;
}

function extract(result) {
  if (result?.stop_reason === "refusal") {
    throw new ProviderError("BLOCKED", "Claude declined to answer (refusal)");
  }
  const text = (result?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!text.trim()) {
    throw new ProviderError("EMPTY", `Claude returned no text (stop_reason=${result?.stop_reason || "none"})`);
  }
  return {
    reply: text,
    truncated: result.stop_reason === "max_tokens",
    totalTokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
  };
}

export async function generate({ model, apiKey, system, prompt, maxTokens, timeoutMs }) {
  const result = await client(apiKey).messages.create(
    {
      model: model.model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    },
    { timeout: timeoutMs }
  );
  return extract(result);
}

export async function generateWithImage({ model, apiKey, system, prompt, maxTokens, timeoutMs, base64Image, mimeType }) {
  const result = await client(apiKey).messages.create(
    {
      model: model.model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
          { type: "text", text: prompt },
        ],
      }],
    },
    { timeout: timeoutMs }
  );
  return extract(result);
}
