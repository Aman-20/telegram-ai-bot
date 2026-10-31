import mongoose from "mongoose";
import { PROVIDERS, providerKey } from "../config/providers.js";
import { DEFAULT_MODELS } from "../config/defaultModels.js";

// ============================================================
//  MODEL REGISTRY  (stored in MongoDB, cached in memory)
//  Admin edits it from Telegram, so no redeploy is needed.
// ============================================================
const schema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    label: { type: String, required: true },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    tier: { type: String, enum: ["free", "pro"], default: "free" },
    vision: { type: Boolean, default: true },
    enabled: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { versionKey: false }
);
const AiModel = mongoose.models.AiModel || mongoose.model("AiModel", schema);

let cache = [];

async function reload() {
  cache = await AiModel.find().sort({ order: 1, _id: 1 }).lean();
}

// Call once after the DB is connected. Seeds defaults when the collection is empty.
export async function init() {
  try {
    if ((await AiModel.countDocuments()) === 0 && DEFAULT_MODELS.length) {
      await AiModel.insertMany(DEFAULT_MODELS.map((m, i) => ({ ...m, enabled: true, order: i })));
      console.log(`🧠 Seeded ${DEFAULT_MODELS.length} default models`);
    }
    await reload();
  } catch (err) {
    console.error("❌ Model registry init failed, using defaults in memory:", err.message);
    cache = DEFAULT_MODELS.map((m, i) => ({ ...m, enabled: true, order: i }));
  }
}

// "active" | "disabled" | "no key" | "unknown provider"
export function modelStatus(m) {
  if (!m.enabled) return "disabled";
  if (!PROVIDERS[m.provider]) return "unknown provider";
  if (!providerKey(m.provider)) return "no key";
  return "active";
}
export const isUsable = (m) => modelStatus(m) === "active";

export const listModels = () => cache.slice();
export const getModel = (id) => cache.find((m) => m.id === id) || null;
export const getUsable = (id) => {
  const m = getModel(id);
  return m && isUsable(m) ? m : null;
};
export const usableModels = () => cache.filter(isUsable);
export const hasTier = (tier) => cache.some((m) => m.tier === tier && isUsable(m));

export async function addModel({ id, label, provider, model, tier, vision }) {
  const existing = getModel(id);
  const order = existing ? existing.order : cache.reduce((a, m) => Math.max(a, m.order || 0), -1) + 1;
  await AiModel.findOneAndUpdate(
    { id },
    { $set: { label, provider, model, tier, vision, enabled: true, order } },
    { upsert: true }
  );
  await reload();
  return !!existing; // true = replaced an existing entry
}

export async function removeModel(id) {
  const res = await AiModel.deleteOne({ id });
  await reload();
  return res.deletedCount > 0;
}

export async function setEnabled(id, enabled) {
  const res = await AiModel.updateOne({ id }, { $set: { enabled } });
  await reload();
  return res.matchedCount > 0;
}
