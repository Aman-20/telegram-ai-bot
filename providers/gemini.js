import { GoogleGenerativeAI } from "@google/generative-ai";
import { ProviderError } from "./errors.js";

const clients = new Map();
function client(apiKey) {
  let c = clients.get(apiKey);
  if (!c) { c = new GoogleGenerativeAI(apiKey); clients.set(apiKey, c); }
  return c;
}

function getModel({ model, apiKey, system, timeoutMs }) {
  return client(apiKey).getGenerativeModel(
    { model: model.model, ...(system ? { systemInstruction: system } : {}) },
    { timeout: timeoutMs }
  );
}

// response.text() throws when Gemini blocks the response (safety etc.)
function extract(result) {
  const r = result?.response;
  const finish = r?.candidates?.[0]?.finishReason;
  let text = "";
  try { text = r?.text() || ""; }
  catch {
    const why = r?.promptFeedback?.blockReason || finish || "blocked";
    throw new ProviderError("BLOCKED", `Gemini blocked the response (${why})`);
  }
  if (!text.trim()) {
    throw new ProviderError(
      finish === "SAFETY" || finish === "RECITATION" ? "BLOCKED" : "EMPTY",
      `Gemini returned no text (finishReason=${finish || "none"}; the model may have used its whole token budget on thinking)`
    );
  }
  return {
    reply: text,
    truncated: finish === "MAX_TOKENS",
    totalTokens: r?.usageMetadata?.totalTokenCount,
  };
}

export async function generate(opts) {
  const { prompt, maxTokens } = opts;
  const result = await getModel(opts).generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  });
  return extract(result);
}

export async function generateWithImage(opts) {
  const { prompt, maxTokens, base64Image, mimeType } = opts;
  const result = await getModel(opts).generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { data: base64Image, mimeType } }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  });
  return extract(result);
}
