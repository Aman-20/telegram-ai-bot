// ============================================================
//  PROVIDERS
//  Each provider = which adapter to use + which env var holds its API key.
//  Keys are read lazily from process.env (never hard-code secrets here).
//
//  type:
//    "gemini"            -> Google Gemini SDK
//    "openai"            -> official OpenAI API
//    "anthropic"         -> Claude API
//    "openai-compatible" -> any service that speaks the OpenAI API (needs baseURL)
//
//  To support a new OpenAI-compatible service, just add one line here
//  and put its key in .env.
// ============================================================
export const PROVIDERS = {
  gemini: { type: "gemini", keyEnv: "GEMINI_API_KEY" },
  openai: { type: "openai", keyEnv: "OPENAI_API_KEY" },
  claude: { type: "anthropic", keyEnv: "CLAUDE_API_KEY" },

  groq: { type: "openai-compatible", keyEnv: "GROQ_API_KEY", baseURL: "https://api.groq.com/openai/v1" },
  openrouter: { type: "openai-compatible", keyEnv: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1" },
  deepseek: { type: "openai-compatible", keyEnv: "DEEPSEEK_API_KEY", baseURL: "https://api.deepseek.com/v1" },
  mistral: { type: "openai-compatible", keyEnv: "MISTRAL_API_KEY", baseURL: "https://api.mistral.ai/v1" },
  together: { type: "openai-compatible", keyEnv: "TOGETHER_API_KEY", baseURL: "https://api.together.xyz/v1" },
};

export function providerKey(name) {
  const p = PROVIDERS[name];
  return p ? (process.env[p.keyEnv] || "").trim() : "";
}
