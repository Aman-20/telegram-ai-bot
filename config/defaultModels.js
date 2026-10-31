// ============================================================
//  DEFAULT MODELS
//  Only used to seed MongoDB the FIRST time the bot starts with an empty
//  model collection. After that, manage models from Telegram:
//    /models  /addmodel  /removemodel  /togglemodel  /testmodel
//
//  EDIT THE MODEL NAMES to whatever you actually use before first start
//  (or just fix them later with /addmodel — same id replaces the entry).
//
//  Fields:
//    id      short unique id (a-z, 0-9, _ -), max 24 chars (used in button data)
//    label   name shown to users
//    provider key from config/providers.js
//    model   exact model name sent to the provider API
//    tier    "free" | "pro"  (pro models count against LIMIT_PRO_MODEL per day)
//    vision  true if the model can read images
// ============================================================
export const DEFAULT_MODELS = [
  { id: "gem-flash", label: "Gemini Flash", provider: "gemini", model: "gemini-2.5-flash", tier: "free", vision: true },
  { id: "gem-pro", label: "Gemini Pro", provider: "gemini", model: "gemini-2.5-pro", tier: "pro", vision: true },
  { id: "gpt-mini", label: "GPT Mini", provider: "openai", model: "gpt-4o-mini", tier: "free", vision: true },
  { id: "gpt-pro", label: "GPT", provider: "openai", model: "gpt-4o", tier: "pro", vision: true },
  { id: "claude-fast", label: "Claude Haiku", provider: "claude", model: "claude-haiku-5-5", tier: "free", vision: true },
  { id: "claude-pro", label: "Claude Sonnet", provider: "claude", model: "claude-sonnet-5-5", tier: "pro", vision: true },
  { id: "groq-llama", label: "Llama (Groq)", provider: "groq", model: "llama-3.3-70b-versatile", tier: "free", vision: false },
];
