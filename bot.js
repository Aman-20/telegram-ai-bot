import express from "express";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import mongoose from "mongoose";
import fetch from "node-fetch";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");
const mammoth = require("mammoth");

dotenv.config();

// ============================================================
//  ENV CONFIGURATION
// ============================================================
const CFG = {
  TOKEN: process.env.TELEGRAM_TOKEN,
  ADMIN_ID: Number(process.env.ADMIN_ID),
  RENDER_URL: process.env.RENDER_URL || "",
  PORT: Number(process.env.PORT) || 3000,
  FORCE_CHANNEL: process.env.FORCE_JOIN_CHANNEL || "",

  DAILY_REQUEST_LIMIT: Number(process.env.DAILY_REQUEST_LIMIT) || 50,
  DAILY_TOKEN_LIMIT: Number(process.env.DAILY_TOKEN_LIMIT) || 50000,
  MAX_REPLY_TOKENS: Number(process.env.MAX_REPLY_TOKENS) || 8192,
  STYLE_PROMPT: process.env.STYLE_PROMPT ||
    "Give a short, concise answer: get straight to the point, no greetings, no filler, no repeating the question. " +
    "Use a few sentences or a short bullet list. Give a longer, detailed answer only if the user explicitly asks for detail. " +
    "Format with simple Markdown only (**bold**, short bullet lists, code blocks for code); do not use tables.",

  DOC_LIMIT: Number(process.env.LIMIT_DOC_ANALYSIS) || 5,
  IMG_LIMIT: Number(process.env.LIMIT_IMG_ANALYSIS) || 10,
  PRO_LIMIT: Number(process.env.LIMIT_PRO_MODEL) || 10,
  PRO_PROVIDER: (process.env.PRO_PROVIDER || "gemini").toLowerCase(),
  PRO_MODEL_NAME: process.env.PRO_MODEL_NAME || "",
  DOC_CHAR_LIMIT: Number(process.env.DOC_CHAR_LIMIT) || 10000,
  MAX_HISTORY_CHARS: Number(process.env.MAX_HISTORY_CHARS) || 500,
  RATE_LIMIT_MS: (Number(process.env.RATE_LIMIT_MS) || 3) * 1000,
  MEDIA_COOLDOWN_MS: (Number(process.env.LIMIT_MEDIA_COOLDOWN) || 10) * 1000,
  MAX_FILE_MB: Number(process.env.MAX_FILE_MB) || 10,

  MAX_CONCURRENT: Number(process.env.MAX_CONCURRENT_REQUESTS) || 20,
  QUEUE_LIMIT: Number(process.env.REQUEST_QUEUE_LIMIT) || 100,
  CACHE_CLEAR_MIN: Number(process.env.MEMORY_CACHE_CLEAR_MINUTES) || 30,
  MEMBER_CACHE_MIN: Number(process.env.MEMBERSHIP_CACHE_MINUTES) || 10,
  APPROVAL_HOURS: Number(process.env.APPROVAL_EXPIRY_HOURS) || 24,
  APPROVAL_CACHE_TTL: (Number(process.env.APPROVAL_CACHE_SECONDS) || 60) * 1000,

  HISTORY_MESSAGES: Number(process.env.HISTORY_MESSAGES) || 10,
  DB_MSG_LIMIT: Number(process.env.DB_MSG_LIMIT) || 20,
  CHAT_HISTORY_TTL: Number(process.env.CHAT_HISTORY_TTL_DAYS) || 30,
  INACTIVE_USER_DAYS: Number(process.env.INACTIVE_USER_DELETE_DAYS) || 90,

  API_TIMEOUT_MS: Number(process.env.API_TIMEOUT_MS) || 90000,

  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
};

function validateEnv() {
  const missing = [];
  if (!CFG.TOKEN) missing.push("TELEGRAM_TOKEN");
  if (!process.env.MONGODB_CONNECT) missing.push("MONGODB_CONNECT");
  if (!CFG.RENDER_URL) missing.push("RENDER_URL");
  if (!CFG.ADMIN_ID || Number.isNaN(CFG.ADMIN_ID)) missing.push("ADMIN_ID (must be a numeric Telegram chat id)");

  if (missing.length) {
    console.error("❌ Missing/invalid required environment variable(s):");
    missing.forEach(m => console.error(`   - ${m}`));
    console.error("Bot cannot start until these are set. Exiting.");
    process.exit(1);
  }

  if (!CFG.GEMINI_API_KEY && !CFG.OPENAI_API_KEY && !CFG.CLAUDE_API_KEY) {
    console.warn("⚠️ No AI provider key set (GEMINI_API_KEY / OPENAI_API_KEY / CLAUDE_API_KEY). " +
      "Every chat, document, and image request will fail until at least one is configured.");
  }
}
validateEnv();

process.on("unhandledRejection", (err) => console.error("⚠️ UnhandledRejection:", err?.message || err));
process.on("uncaughtException", (err) => console.error("⚠️ UncaughtException:", err?.message || err));

// ============================================================
//  MONGODB
// ============================================================
mongoose.connection.on("disconnected", () => {
  console.warn("⚠️ MongoDB disconnected — reconnecting…");
  setTimeout(connectDB, 3000);
});
mongoose.connection.on("error", (err) => {
  console.error("❌ MongoDB error:", err.message);
});

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_CONNECT, {
      dbName: "TelegramAi",
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
    });
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    setTimeout(connectDB, 5000);
  }
}

const settingsSchema = new mongoose.Schema(
  { key: { type: String, required: true, unique: true }, value: mongoose.Schema.Types.Mixed },
  { versionKey: false }
);
const Setting = mongoose.model("Setting", settingsSchema);

const dailyStatsSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, unique: true },
    tokens: { type: Number, default: 0 },
    requests: { type: Number, default: 0 },
    doc: { type: Number, default: 0 },
    img: { type: Number, default: 0 },
    createdAt: { type: Date, default: () => new Date(), index: { expireAfterSeconds: 7 * 86400 } },
  },
  { versionKey: false }
);
const DailyStats = mongoose.model("DailyStats", dailyStatsSchema);

function bumpStats(fields) {
  const today = utcToday();
  return DailyStats.findOneAndUpdate(
    { date: today },
    { $inc: fields },
    { upsert: true, new: true }
  ).catch(e => console.error("❌ bumpStats error:", e.message));
}

const userSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, unique: true },
    approvedUntil: { type: Date, default: null },
    selectedModel: { type: String, default: "gemini_1" },
    language: { type: String, default: "en" },
    requests: { type: Number, default: 0 },
    lastReset: { type: Date, default: () => new Date() },
    tokensUsed: { type: Number, default: 0 },
    tokensReset: { type: Date, default: () => new Date() },
    accountCreated: { type: Date, default: () => new Date() },
    lastActive: { type: Date, default: () => new Date() },
  },
  { versionKey: false }
);
userSchema.add({
  banned: { type: Boolean, default: false },
  bannedAt: { type: Date, default: null },
  banReason: { type: String, default: "" },
});
userSchema.index({ approvedUntil: 1 });
userSchema.index({ lastActive: 1 });
const User = mongoose.model("User", userSchema);

const chatHistorySchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true },
    messages: [{
      role: { type: String, enum: ["user", "bot"], required: true },
      text: { type: String, maxlength: CFG.MAX_HISTORY_CHARS },
      createdAt: { type: Date, default: () => new Date() },
    }],
    updatedAt: {
      type: Date,
      default: () => new Date(),
      index: { expireAfterSeconds: CFG.CHAT_HISTORY_TTL * 86400 },
    },
  },
  { versionKey: false }
);
chatHistorySchema.index({ chatId: 1 }, { unique: true });
const ChatHistory = mongoose.model("ChatHistory", chatHistorySchema);

// ============================================================
//  IN-MEMORY CACHES
// ============================================================
const rateLimitMap = new Map();
const mediaRateLimit = new Map();

const membershipCache = new Map();
const approvalCache = new Map();
const banCache = new Map();

const userUsage = new Map();

const userLanguages = new Map();
const userModels = new Map();
const _prefsPending = new Map();

const albumSeen = new Map();

const processingSet = new Set();
const processingTimers = new Map();
const PROCESSING_TIMEOUT = 3 * 60 * 1000;

function cid(chatId) { return String(chatId); }

function senderId(msg) {
  return msg.from?.id ?? msg.chat.id;
}
function displayName(user) {
  return user?.first_name || (user?.username ? `@${user.username}` : "there");
}
async function safeReply(msg, text, opts = {}) {
  return safeSend(msg.chat.id, text, opts);
}

setInterval(() => {
  const now = Date.now();
  const STALE = CFG.CACHE_CLEAR_MIN * 60 * 1000;
  const today = utcToday();

  for (const [k, v] of rateLimitMap) if (now - v > STALE) rateLimitMap.delete(k);
  for (const [k, v] of mediaRateLimit) if (now - v > STALE) mediaRateLimit.delete(k);
  for (const [k, v] of membershipCache) if (now > v.expiry) membershipCache.delete(k);
  for (const [k, v] of approvalCache) if (now > v.expiry) approvalCache.delete(k);
  for (const [k, v] of userUsage) if (v.date !== today) userUsage.delete(k);
  for (const [k, v] of banCache) if (now > v.expiry) banCache.delete(k);
  if (userLanguages.size > 5000) userLanguages.clear();
  if (userModels.size > 5000) userModels.clear();

  console.log(`🧹 Cache swept [${new Date().toISOString()}] rateLimits=${rateLimitMap.size} prefs=${userLanguages.size}`);
}, CFG.CACHE_CLEAR_MIN * 60 * 1000);

// ============================================================
//  CONCURRENCY LIMITER
// ============================================================
let activeRequests = 0;
const requestQueue = [];

async function enqueueRequest(fn) {
  if (activeRequests + requestQueue.length >= CFG.QUEUE_LIMIT) {
    throw new Error("QUEUE_FULL");
  }

  return new Promise((resolve, reject) => {
    const task = async () => {
      activeRequests++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally {
        activeRequests--;
        if (requestQueue.length > 0) {
          const next = requestQueue.shift();
          try { next(); } catch (e) { console.error("Queue task error:", e); }
        }
      }
    };

    if (activeRequests < CFG.MAX_CONCURRENT) {
      task();
    } else {
      requestQueue.push(task);
    }
  });
}

// ============================================================
//  AI MODELS
// ============================================================
function buildProModelEntry() {
  const provider = CFG.PRO_PROVIDER;
  const keyByProvider = {
    gemini: CFG.GEMINI_API_KEY,
    openai: CFG.OPENAI_API_KEY,
    claude: CFG.CLAUDE_API_KEY,
  };
  return {
    id: "pro",
    name: CFG.PRO_MODEL_NAME,
    key: keyByProvider[provider],
    provider,
    model: CFG.PRO_MODEL_NAME,
  };
}

const MODELS = {
  gemini_1: { id: "gemini_1", name: process.env.GEMINI_MODEL_1, key: process.env.GEMINI_API_KEY, provider: "gemini", model: process.env.GEMINI_MODEL_1 },
  gemini_2: { id: "gemini_2", name: process.env.GEMINI_MODEL_2, key: process.env.GEMINI_API_KEY, provider: "gemini", model: process.env.GEMINI_MODEL_2 },
  gemini_3: { id: "gemini_3", name: process.env.GEMINI_MODEL_3, key: process.env.GEMINI_API_KEY, provider: "gemini", model: process.env.GEMINI_MODEL_3 },
  gemini_4: { id: "gemini_4", name: process.env.GEMINI_MODEL_4, key: process.env.GEMINI_API_KEY, provider: "gemini", model: process.env.GEMINI_MODEL_4 },
  openai: { id: "openai", name: process.env.OPENAI_MODEL_1, key: process.env.OPENAI_API_KEY, provider: "openai", model: process.env.OPENAI_MODEL_1 },
  claude: { id: "claude", name: process.env.CLAUDE_MODEL_1, key: process.env.CLAUDE_API_KEY, provider: "claude", model: process.env.CLAUDE_MODEL_1 },
};

if (CFG.PRO_MODEL_NAME) {
  MODELS.pro = buildProModelEntry();
}

const genAI = new GoogleGenerativeAI(CFG.GEMINI_API_KEY || "");

let _openai = null;
let _anthropic = null;
function getOpenAI() {
  if (!CFG.OPENAI_API_KEY) throw new Error("NO_KEY");
  return (_openai ??= new OpenAI({ apiKey: CFG.OPENAI_API_KEY }));
}
function getAnthropic() {
  if (!CFG.CLAUDE_API_KEY) throw new Error("NO_KEY");
  return (_anthropic ??= new Anthropic({ apiKey: CFG.CLAUDE_API_KEY }));
}

const LANGUAGES = {
  en: "🇬🇧 English", hi: "🇮🇳 Hindi", es: "🇪🇸 Spanish",
  fr: "🇫🇷 French", de: "🇩🇪 German", ja: "🇯🇵 Japanese",
  ru: "🇷🇺 Russian", ar: "🇸🇦 Arabic",
};

// ============================================================
//  BOT + EXPRESS SETUP
// ============================================================
let PUBLIC_MODE = false;

const app = express();
app.use(express.json());
app.set("view engine", "ejs");

const siteData = {
  botName: process.env.BOT_DISPLAY_NAME || "DnaforkAi Bot",
  botLink: `https://t.me/${process.env.BOT_USERNAME || "dnafork_bot"}`,
  supportLink: `https://t.me/${process.env.SUPPORT_USERNAME || "dnafork_support"}`,
};

function safeRender(res, view) {
  res.render(view, siteData, (err, html) => {
    if (err) return res.send(`<h1>${view}</h1><p>Page coming soon.</p>`);
    res.send(html);
  });
}
app.get("/", (_q, res) => safeRender(res, "home"));
app.get("/privacy", (_q, res) => safeRender(res, "privacy"));
app.get("/terms", (_q, res) => safeRender(res, "terms"));
app.get("/health", (_q, res) => res.json({
  status: "ok",
  db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  queue: { active: activeRequests, waiting: requestQueue.length },
  uptime: Math.floor(process.uptime()),
}));

const bot = new TelegramBot(CFG.TOKEN);

function isPrivateUpdate(update) {
  const chat =
    update?.message?.chat ||
    update?.edited_message?.chat ||
    update?.callback_query?.message?.chat ||
    update?.channel_post?.chat;
  return !chat || chat.type === "private";
}

function updateSenderId(update) {
  return (
    update?.message?.from?.id ??
    update?.edited_message?.from?.id ??
    update?.callback_query?.from?.id ??
    null
  );
}

app.post(`/bot${CFG.TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!isPrivateUpdate(update)) return;

  try {
    if (await isBanned(updateSenderId(update))) return;
  } catch (err) {
    console.error("⚠️ Ban check failed (letting update through):", err.message);
  }
  bot.processUpdate(update);
});

bot.setMyCommands([
  { command: "start", description: "🚀 Start the bot" },
  { command: "help", description: "📝 List of commands" },
  { command: "account", description: "👤 My account info" },
  { command: "language", description: "🌐 Change language" },
  { command: "setmodel", description: "🤖 Select AI model" },
  { command: "clearchat", description: "🧹 Clear chat history" },
]).catch(() => { });

// ============================================================
//  HELPERS
// ============================================================
function utcToday() { return new Date().toISOString().slice(0, 10); }

function needsDailyReset(dateField) {
  if (!dateField) return true;
  return new Date(dateField).toISOString().slice(0, 10) !== utcToday();
}

function withTimeout(promise, ms, label) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`TIMEOUT:${label}`)), ms)
  );
  return Promise.race([promise, timer]);
}

function getUsageBucket(chatId) {
  const today = utcToday();
  const key = cid(chatId);
  let u = userUsage.get(key);
  if (!u || u.date !== today) {
    u = { date: today, doc: 0, img: 0, proTokens: 0 };
    userUsage.set(key, u);
  }
  return u;
}

function checkLimit(chatId, type, limit) {
  const u = getUsageBucket(chatId);
  if (u[type] >= limit) return false;
  u[type]++;
  return true;
}

function hasQuotaLeft(chatId, type, limit) {
  return getUsageBucket(chatId)[type] < limit;
}

async function commitLimit(chatId, type) {
  const u = getUsageBucket(chatId);
  u[type]++;
  await bumpStats({ [type]: 1 });
}

async function isUserMember(chatId) {
  if (!CFG.FORCE_CHANNEL) return true;
  const key = cid(chatId);
  const cached = membershipCache.get(key);
  if (cached && Date.now() < cached.expiry) return cached.isMember;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const member = await withTimeout(
        bot.getChatMember(CFG.FORCE_CHANNEL, chatId),
        5000, "membership"
      );
      const isMember = ["creator", "administrator", "member"].includes(member.status);
      membershipCache.set(key, { isMember, expiry: Date.now() + CFG.MEMBER_CACHE_MIN * 60000 });
      return isMember;
    } catch (err) {
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 800));
        continue;
      }
      const stale = membershipCache.get(key);
      console.warn(`⚠️ Membership check failed (both attempts): ${err.message}`);
      return stale?.isMember ?? false;
    }
  }
}

async function checkMembership(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id || chatId;
  if (await isUserMember(userId)) return true;
  await safeReply(msg, "🔒 *Join our channel first*\n_You need to be a member to use this bot._", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[
        { text: "📢 Join Channel", url: `https://t.me/${CFG.FORCE_CHANNEL.replace("@", "")}` },
        { text: "✅ I have joined", callback_data: "verify_membership" },
      ]],
    },
  });
  return false;
}

async function isBanned(chatId) {
  if (!chatId || Number(chatId) === CFG.ADMIN_ID) return false;
  const key = cid(chatId);
  const cached = banCache.get(key);
  if (cached && Date.now() < cached.expiry) return cached.banned;

  const u = await User.findOne({ chatId: key }, { banned: 1 }).lean();
  const banned = !!u?.banned;
  banCache.set(key, { banned, expiry: Date.now() + CFG.APPROVAL_CACHE_TTL });
  return banned;
}

async function isUserApproved(chatId) {
  if (PUBLIC_MODE) return true;
  if (chatId === CFG.ADMIN_ID) return true;
  const key = cid(chatId);
  const cached = approvalCache.get(key);
  if (cached && Date.now() < cached.expiry) return cached.approved;

  const user = await User.findOne({ chatId: key }, { approvedUntil: 1 });
  const approved = !!(user?.approvedUntil && new Date() <= user.approvedUntil);
  approvalCache.set(key, { approved, expiry: Date.now() + CFG.APPROVAL_CACHE_TTL });
  return approved;
}

async function guardAccess(msg) {
  if (await isUserApproved(senderId(msg))) return true;
  await safeReply(msg, `🛡️ *Members Only*\nThis feature is locked.\n📩 Contact ${escapeMarkdown(CFG.FORCE_CHANNEL || "the admin")} to get approved.`,
    { parse_mode: "Markdown" }
  );
  return false;
}

async function guardRateLimit(msg) {
  if (msg.text?.startsWith("/")) return true;
  if (msg.photo || msg.document) return true;
  const key = cid(senderId(msg));
  const now = Date.now();
  const rem = CFG.RATE_LIMIT_MS - (now - (rateLimitMap.get(key) || 0));
  if (rem > 0) {
    await safeReply(msg, `⏳ Please wait ${Math.ceil(rem / 1000)}s before sending another request.`);
    return false;
  }
  rateLimitMap.set(key, now);
  return true;
}

async function guardRateLimitMedia(msg) {
  const key = cid(senderId(msg));
  const now = Date.now();
  const rem = CFG.MEDIA_COOLDOWN_MS - (now - (mediaRateLimit.get(key) || 0));
  if (rem > 0) {
    await safeReply(msg, `⏳ Please wait ${Math.ceil(rem / 1000)}s before sending another file.`);
    return false;
  }
  mediaRateLimit.set(key, now);
  return true;
}

function isProcessing(chatId) { return processingSet.has(cid(chatId)); }
function markProcessing(chatId) {
  const key = cid(chatId);
  clearTimeout(processingTimers.get(key));
  processingSet.add(key);
  processingTimers.set(key, setTimeout(() => {
    processingSet.delete(key);
    processingTimers.delete(key);
  }, PROCESSING_TIMEOUT));
}
function unmarkProcessing(chatId) {
  const key = cid(chatId);
  clearTimeout(processingTimers.get(key));
  processingTimers.delete(key);
  processingSet.delete(key);
}

async function getOrCreateUser(chatId) {
  const key = cid(chatId);
  try {
    return await User.findOneAndUpdate(
      { chatId: key },
      { $setOnInsert: { chatId: key } },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err.code === 11000) return User.findOne({ chatId: key });
    throw err;
  }
}

async function reserveQuota(chatId, promptText) {
  const user = await getOrCreateUser(chatId);

  const resetUpdates = {};
  if (needsDailyReset(user.lastReset)) { resetUpdates.requests = 0; resetUpdates.lastReset = new Date(); user.requests = 0; }
  if (needsDailyReset(user.tokensReset)) { resetUpdates.tokensUsed = 0; resetUpdates.tokensReset = new Date(); user.tokensUsed = 0; }
  if (Object.keys(resetUpdates).length) {
    await User.findOneAndUpdate({ chatId: cid(chatId) }, { $set: resetUpdates });
  }

  if (user.requests >= CFG.DAILY_REQUEST_LIMIT) {
    throw new Error("DAILY_REQUEST_LIMIT");
  }

  const inputTokens = Math.ceil(String(promptText).split(/\s+/).length * 1.3);
  if (user.tokensUsed + inputTokens >= CFG.DAILY_TOKEN_LIMIT) {
    throw new Error("DAILY_TOKEN_LIMIT");
  }

  return { user, inputTokens };
}

async function finalizeUsage(chatId, user, inputTokens, reply, chosen) {
  const outputTokens = Math.ceil(String(reply).split(/\s+/).length * 1.3);
  const totalTokens = inputTokens + outputTokens;

  if (user.tokensUsed + totalTokens > CFG.DAILY_TOKEN_LIMIT) {
    throw new Error("DAILY_TOKEN_LIMIT");
  }

  await User.findOneAndUpdate(
    { chatId: cid(chatId) },
    { $inc: { requests: 1, tokensUsed: totalTokens }, $set: { lastActive: new Date() } }
  );
  await bumpStats({ tokens: totalTokens, requests: 1 });

  const remaining = CFG.DAILY_REQUEST_LIMIT - (user.requests + 1);
  const tokLeft = CFG.DAILY_TOKEN_LIMIT - (user.tokensUsed + totalTokens);
  return `\n\n🤖 <b>${escapeHtml(chosen.name || "")}</b>  |  📨 ${remaining} left  |  🪙 ${tokLeft} tokens`;
}

async function downloadFile(fileId) {
  const file = await withTimeout(bot.getFile(fileId), CFG.API_TIMEOUT_MS, "getFile");
  const MAX_BYTES = CFG.MAX_FILE_MB * 1024 * 1024;
  if (file.file_size && file.file_size > MAX_BYTES) {
    throw new Error(`FILE_TOO_LARGE:${CFG.MAX_FILE_MB}`);
  }
  const fileUrl = `https://api.telegram.org/file/bot${CFG.TOKEN}/${file.file_path}`;
  const res = await withTimeout(fetch(fileUrl), CFG.API_TIMEOUT_MS, "downloadFile");
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function splitSafely(text, maxLen = 4000) {
  const chunks = [];
  while (text.length > maxLen) {
    let idx = text.lastIndexOf("\n", maxLen);
    if (idx < maxLen * 0.5) idx = maxLen;
    chunks.push(text.slice(0, idx));
    text = text.slice(idx).trimStart();
  }
  if (text) chunks.push(text);
  return chunks;
}

async function sendLongMessage(chatId, text, opts = {}) {
  for (const chunk of splitSafely(text)) {
    try { await bot.sendMessage(chatId, chunk, opts); }
    catch { await bot.sendMessage(chatId, chunk); }
  }
}

async function safeSend(chatId, text, opts = {}) {
  if (text.length > 4000) return sendLongMessage(chatId, text, opts);
  try {
    return await bot.sendMessage(chatId, text, opts);
  } catch (err) {
    const msg = err?.message || "";
    const code = err?.response?.statusCode;

    if (code === 429 || msg.includes("Too Many Requests")) {
      const retryAfter = (err?.response?.body?.parameters?.retry_after || 5) * 1000;
      console.warn(`⚠️ Telegram 429 for ${chatId} — retrying after ${retryAfter}ms`);
      await new Promise(r => setTimeout(r, retryAfter));
      try { return await bot.sendMessage(chatId, text, opts); }
      catch (retryErr) { console.error(`❌ safeSend retry failed for ${chatId}:`, retryErr.message); }
      return;
    }

    if (code === 403 || msg.includes("Forbidden") || msg.includes("bot was blocked")) {
      console.warn(`⚠️ Bot blocked by ${chatId} — removing from DB`);
      User.deleteOne({ chatId: cid(chatId) }).catch(e =>
        console.error("❌ Failed to remove blocked user:", e.message)
      );
      ChatHistory.deleteOne({ chatId: cid(chatId) }).catch(e =>
        console.error("❌ Failed to remove blocked user history:", e.message)
      );
      return;
    }

    if (msg.includes("can't parse") && opts.parse_mode) {
      const { parse_mode: _, ...safe } = opts;
      try { return await bot.sendMessage(chatId, text, safe); }
      catch (plainErr) { console.error(`❌ safeSend plain-text fallback failed for ${chatId}:`, plainErr.message); }
      return;
    }

    if (code >= 500 || msg.includes("ETIMEOUT") || msg.includes("ECONNRESET") || msg.includes("socket hang up")) {
      console.error(`❌ Telegram server/network error for ${chatId} (${code || "network"}):`, msg);
      return;
    }

    console.warn(`⚠️ safeSend unhandled error for ${chatId} [${code}]:`, msg);
  }
}

function escapeMarkdown(text) {
  return text.replace(/([_*`\[\]])/g, "\\$1");
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mdToHtml(md) {
  let t = String(md).replace(/\r\n/g, "\n");
  if ((t.match(/```/g) || []).length % 2 === 1) t += "\n```";

  const stash = [];
  const hold = (html) => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };

  t = t.replace(/```([\w+#.-]*)[^\S\n]*\n?([\s\S]*?)```/g, (_, lang, code) => {
    const body = escapeHtml(code.replace(/\n$/, ""));
    return hold(lang
      ? `<pre><code class="language-${lang}">${body}</code></pre>`
      : `<pre>${body}</pre>`);
  });
  t = t.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${escapeHtml(c)}</code>`));

  t = escapeHtml(t);

  t = t.replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, "──────────");
  t = t.replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, (_, h) => `<b>${h.replace(/\*\*|__/g, "")}</b>`);
  t = t.replace(/^(\s*)[*+-]\s+/gm, "$1• ");
  t = t.replace(/^&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>");
  t = t.replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>");
  t = t.replace(/__([^\n]+?)__/g, "<b>$1</b>");
  t = t.replace(/~~([^\n]+?)~~/g, "<s>$1</s>");
  t = t.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1<i>$2</i>");
  t = t.replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1<i>$2</i>");
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

function splitMarkdown(text, maxLen = 3000) {
  const chunks = [];
  let rest = String(text);
  let reopen = "";
  while (rest.length + reopen.length > maxLen) {
    const room = maxLen - reopen.length - 4;
    let idx = rest.lastIndexOf("\n", room);
    if (idx < room * 0.5) idx = room;
    let chunk = reopen + rest.slice(0, idx);
    rest = rest.slice(idx).replace(/^\n+/, "");
    if ((chunk.match(/```/g) || []).length % 2 === 1) { chunk += "\n```"; reopen = "```\n"; }
    else reopen = "";
    chunks.push(chunk);
  }
  const last = reopen + rest;
  if (last.trim()) chunks.push(last);
  return chunks;
}

async function sendAIReply(chatId, header, reply, truncated, footerHtml) {
  const chunks = splitMarkdown(reply);
  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;

    let html = mdToHtml(chunks[i]);
    if (isFirst && header) html = `<b>${escapeHtml(header)}</b>\n\n${html}`;
    if (isLast) {
      if (truncated) html += "\n\n⚠️ <i>The reply hit the length limit and was cut off. Send “continue” to get the rest.</i>";
      html += footerHtml || "";
    }

    try {
      await bot.sendMessage(chatId, html, { parse_mode: "HTML", disable_web_page_preview: true });
    } catch (err) {
      console.warn(`⚠️ HTML send failed for ${chatId}, falling back to plain text: ${err.message}`);
      const plain = (isFirst && header ? header + "\n\n" : "") + chunks[i];
      await safeSend(chatId, plain);
    }
    if (!isLast) await new Promise(r => setTimeout(r, 350));
  }
}

async function withThinkingIndicator(chatId, label, fn) {
  let placeholder;
  try { placeholder = await bot.sendMessage(chatId, label); } catch { }

  const typingInterval = setInterval(
    () => bot.sendChatAction(chatId, "typing").catch(() => { }),
    4000
  );
  try {
    return await fn();
  } finally {
    clearInterval(typingInterval);
    if (placeholder?.message_id) {
      bot.deleteMessage(chatId, placeholder.message_id).catch(() => { });
    }
  }
}

function checkProLimit(chatId, chosen) {
  if (chosen.id === "pro") {
    if (!checkLimit(chatId, "proTokens", CFG.PRO_LIMIT)) {
      throw new Error(`PRO_LIMIT:${CFG.PRO_LIMIT}`);
    }
  }
}

async function callModel(chatId, chosen, promptText) {
  if (!chosen?.key) throw new Error("NO_KEY");
  checkProLimit(chatId, chosen);

  if (chosen.provider === "gemini") {
    const model = genAI.getGenerativeModel({ model: chosen.model });
    const result = await withTimeout(
      model.generateContent({
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        generationConfig: { maxOutputTokens: CFG.MAX_REPLY_TOKENS },
      }),
      CFG.API_TIMEOUT_MS, "gemini"
    );
    return {
      reply: result?.response?.text() || "⚠️ No response from Gemini (the model may have used its whole token budget on thinking).",
      chosen,
      truncated: result?.response?.candidates?.[0]?.finishReason === "MAX_TOKENS",
    };
  }

  if (chosen.provider === "openai") {
    const result = await withTimeout(
      getOpenAI().chat.completions.create({
        model: chosen.model,
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: promptText },
        ],
        max_completion_tokens: CFG.MAX_REPLY_TOKENS,
      }),
      CFG.API_TIMEOUT_MS, "openai"
    );
    return {
      reply: result.choices[0].message.content || "⚠️ No response from OpenAI (the model may have used its whole token budget on reasoning).",
      chosen,
      truncated: result.choices[0].finish_reason === "length",
    };
  }

  if (chosen.provider === "claude") {
    const result = await withTimeout(
      getAnthropic().messages.create({
        model: chosen.model,
        max_tokens: CFG.MAX_REPLY_TOKENS,
        messages: [{ role: "user", content: promptText }],
      }),
      CFG.API_TIMEOUT_MS, "claude"
    );
    return {
      reply: result.content?.find(b => b.type === "text")?.text || "⚠️ No response from Claude.",
      chosen,
      truncated: result.stop_reason === "max_tokens",
    };
  }

  throw new Error("UNKNOWN_PROVIDER");
}

async function callVisionModel(chatId, chosen, base64Image, mimeType, instructionText) {
  if (!chosen?.key) throw new Error("NO_KEY");
  checkProLimit(chatId, chosen);

  if (chosen.provider === "gemini") {
    const model = genAI.getGenerativeModel({ model: chosen.model });
    const result = await withTimeout(
      model.generateContent([
        instructionText,
        { inlineData: { data: base64Image, mimeType } },
      ]),
      CFG.API_TIMEOUT_MS, "gemini-img"
    );
    return {
      reply: result?.response?.text() || "⚠️ No response from Gemini (the model may have used its whole token budget on thinking).",
      chosen,
      truncated: result?.response?.candidates?.[0]?.finishReason === "MAX_TOKENS",
    };
  }

  if (chosen.provider === "openai") {
    const result = await withTimeout(
      getOpenAI().chat.completions.create({
        model: chosen.model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: instructionText },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } },
          ],
        }],
        max_completion_tokens: CFG.MAX_REPLY_TOKENS,
      }),
      CFG.API_TIMEOUT_MS, "openai-img"
    );
    return {
      reply: result.choices[0].message.content || "⚠️ No response from OpenAI (the model may have used its whole token budget on reasoning).",
      chosen,
      truncated: result.choices[0].finish_reason === "length",
    };
  }

  if (chosen.provider === "claude") {
    const result = await withTimeout(
      getAnthropic().messages.create({
        model: chosen.model,
        max_tokens: CFG.MAX_REPLY_TOKENS,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
            { type: "text", text: instructionText },
          ],
        }],
      }),
      CFG.API_TIMEOUT_MS, "claude-img"
    );
    return {
      reply: result.content?.find(b => b.type === "text")?.text || "⚠️ No response from Claude.",
      chosen,
      truncated: result.stop_reason === "max_tokens",
    };
  }

  throw new Error("UNKNOWN_PROVIDER");
}

async function getAIReply(chatId, text, history, lang) {
  const selectedId = userModels.get(cid(chatId)) || "gemini_1";
  const chosen = MODELS[selectedId];
  const prompt = `Answer in ${LANGUAGES[lang] || "English"} (${lang}).\n${CFG.STYLE_PROMPT}\n\nConversation so far:\n${history}\n\nUser: ${text}`;
  return callModel(chatId, chosen, prompt);
}

async function hydrateUserPrefs(chatId) {
  const key = cid(chatId);
  if (userLanguages.has(key) && userModels.has(key)) return;
  if (_prefsPending.has(key)) return _prefsPending.get(key);

  const promise = User.findOne({ chatId: key }, { language: 1, selectedModel: 1 })
    .then(u => {
      if (!userLanguages.has(key)) userLanguages.set(key, u?.language || "en");
      if (!userModels.has(key)) userModels.set(key, u?.selectedModel || "gemini_1");
    })
    .catch(() => {
      userLanguages.set(key, "en");
      userModels.set(key, "gemini_1");
    })
    .finally(() => _prefsPending.delete(key));

  _prefsPending.set(key, promise);
  return promise;
}

async function appendChatHistory(chatId, userText, botText, truncated = false) {
  const key = cid(chatId);
  const now = new Date();
  const botStored = truncated
    ? "…" + String(botText).slice(-CFG.MAX_HISTORY_CHARS)
    : String(botText).slice(0, CFG.MAX_HISTORY_CHARS);
  const newMessages = [
    { role: "user", text: String(userText).slice(0, CFG.MAX_HISTORY_CHARS), createdAt: now },
    { role: "bot", text: botStored.slice(0, CFG.MAX_HISTORY_CHARS), createdAt: now },
  ];
  await ChatHistory.findOneAndUpdate(
    { chatId: key },
    {
      $push: { messages: { $each: newMessages, $slice: -CFG.DB_MSG_LIMIT } },
      $set: { updatedAt: now },
    },
    { upsert: true }
  ).catch(err => console.error("appendChatHistory error:", err.message));
}

async function getRecentHistory(chatId) {
  const doc = await ChatHistory.findOne(
    { chatId: cid(chatId) },
    { messages: { $slice: -CFG.HISTORY_MESSAGES } }
  );
  if (!doc?.messages?.length) return "";
  return doc.messages.map(m => `${m.role}: ${m.text}`).join("\n");
}

async function broadcastMessage(message) {
  let success = 0, failed = 0;
  const DELAY = 220;

  const cursor = User.find({ banned: { $ne: true } }, { chatId: 1 }).cursor();
  for await (const u of cursor) {
    try {
      await bot.sendMessage(u.chatId, `📢 Broadcast:\n\n${message}`);
      success++;
    } catch { failed++; }
    await new Promise(r => setTimeout(r, DELAY));
  }
  return { success, failed };
}

// ============================================================
//  STARTUP
// ============================================================
async function startup() {
  await connectDB();

  try {
    const s = await Setting.findOne({ key: "publicMode" });
    if (s) PUBLIC_MODE = !!s.value;
  } catch { }
  console.log(`🔑 PUBLIC_MODE: ${PUBLIC_MODE}`);

  try {
    await withTimeout(
      bot.setWebHook(`${CFG.RENDER_URL}/bot${CFG.TOKEN}`),
      10000, "setWebhook"
    );
    console.log("✅ Webhook registered");
  } catch (err) {
    console.error("❌ Webhook registration failed:", err.message);
  }

  app.listen(CFG.PORT, () => console.log(`✅ Server on port ${CFG.PORT}`));

  runCleanup();
  setInterval(runCleanup, 24 * 60 * 60 * 1000);

  console.log("🤖 Bot fully ready");
}

async function runCleanup() {
  console.log(`🔧 Cleanup started [${new Date().toISOString()}]`);
  try {
    const cutoff = new Date(Date.now() - CFG.INACTIVE_USER_DAYS * 86400000);
    const res = await User.deleteMany({
      lastActive: { $lt: cutoff },
      approvedUntil: { $not: { $gt: new Date() } },
      banned: { $ne: true },
    });
    if (res.deletedCount > 0) console.log(`🗑️  Removed ${res.deletedCount} inactive users`);
  } catch (err) {
    console.error("❌ Cleanup error:", err.message);
  }
}

// ============================================================
//  BOT COMMANDS
// ============================================================
const LINE = "━━━━━━━━━━━━━━";

const cmd = (name) => new RegExp(`^\\/${name}(?:@\\w+)?(?:\\s|$)`, "i");

function progressBar(used, limit, size = 10) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const filled = Math.round(ratio * size);
  return "▰".repeat(filled) + "▱".repeat(size - filled);
}

function fmtDuration(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

bot.onText(cmd("start"), async (msg) => {
  if (!await checkMembership(msg)) return;
  const uid = senderId(msg);

  await getOrCreateUser(uid);
  const key = cid(uid);
  if (!userModels.has(key)) userModels.set(key, "gemini_1");
  if (!userLanguages.has(key)) userLanguages.set(key, "en");

  await safeSend(msg.chat.id,
    `👋 *Welcome, ${escapeMarkdown(displayName(msg.from))}!*\n` +
    `${LINE}\n` +
    `I'm your personal *AI assistant* ✨\n` +
    `Ask me anything, or send an image or document to analyze.\n\n` +
    `👉 _Tap /help to explore everything I can do._`,
    { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
  );
});

bot.onText(cmd("help"), async (msg) => {
  if (!await checkMembership(msg)) return;
  const contact = escapeHtml(CFG.FORCE_CHANNEL || "the admin");

  await safeReply(msg,
    `📖 <b>Help Center</b>\n${LINE}\n\n` +
    `💬 <b>Getting Started</b>\n` +
    `Just type your question, or send <b>images</b> and <b>documents</b> for analysis.\n\n` +
    `⚙️ <b>Settings</b>\n` +
    `/setmodel — choose AI model\n` +
    `/language — choose language\n` +
    `/clearchat — clear chat history\n\n` +
    `👤 <b>Account</b>\n` +
    `/account — usage &amp; limits\n` +
    `/status — check access\n` +
    `/about — about this bot\n` +
    `/terms — terms &amp; privacy\n\n` +
    `📌 <b>Note:</b> <i>Responses may occasionally fail due to model limits. Please try again shortly.</i>`,
    { parse_mode: "HTML" }
  );
});

bot.onText(cmd("about"), async (msg) => {
  if (!await checkMembership(msg)) return;
  const models = Object.values(MODELS)
    .filter(m => m.key && m.name)
    .map(m => `• ${escapeMarkdown(m.name)}`)
    .join("\n");

  await safeReply(msg,
    `🤖 *About This Bot*\n${LINE}\n` +
    `_Your smart AI assistant, right inside Telegram._\n\n` +
    `🛠 *How I'm Built*\n` +
    `Powered by advanced AI language models\n` +
    `Built to understand text, images and documents\n` +
    `Designed to give short, clear answers\n\n` +
    (models ? `🧠 *AI models*\n${models}\n\n` : "") +
    `⚠️ _AI can make mistakes — double-check important information._`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(cmd("terms"), async (msg) => {
  if (!await checkMembership(msg)) return;
  await safeReply(msg,
    `📜 *Terms of Service*\n${LINE}\n` +
    `1️⃣ Personal & educational use only\n` +
    `2️⃣ No harmful or illegal content\n` +
    `3️⃣ Limited usage data is stored\n` +
    `4️⃣ AI answers may be inaccurate\n` +
    `5️⃣ Using the bot means you accept these terms\n\n` +
    `_Tap a button below to read the full documents._`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "📄 Full Terms", url: `${CFG.RENDER_URL}/terms` },
          { text: "🔒 Privacy", url: `${CFG.RENDER_URL}/privacy` },
        ]]
      },
    }
  );
});

bot.onText(cmd("status"), async (msg) => {
  const uid = senderId(msg);

  if (PUBLIC_MODE) {
    return safeReply(msg,
      `🔓 *Public Mode*\n${LINE}\n_Everyone can use all features._`,
      { parse_mode: "Markdown" }
    );
  }

  if (!await isUserApproved(uid)) {
    return safeReply(msg,
      `🚧 *No Access Yet*\n${LINE}\n` +
      `This bot is for members only.\n` +
      `📩 Contact ${escapeMarkdown(CFG.FORCE_CHANNEL || "the admin")} to get approved.`,
      { parse_mode: "Markdown" }
    );
  }

  let expiry = "";
  if (uid !== CFG.ADMIN_ID) {
    try {
      const u = await User.findOne({ chatId: cid(uid) }, { approvedUntil: 1 });
      if (u?.approvedUntil) expiry = `\n⏳ _Expires in ${fmtDuration(new Date(u.approvedUntil) - Date.now())}_`;
    } catch { }
  }
  await safeReply(msg,
    `✅ *Access Active*\n${LINE}\nYou can use all features.${expiry}`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(cmd("clearchat"), async (msg) => {
  const uid = senderId(msg);
  if (!await checkMembership(msg)) return;
  try {
    await ChatHistory.deleteOne({ chatId: cid(uid) });
    await safeReply(msg,
      `🧹 *Chat History Cleared*\n${LINE}\n_We're starting fresh — I've forgotten our earlier conversation._`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("clearchat error:", err.message);
    await safeReply(msg, "⚠️ Could not clear your history. Please try again.");
  }
});

bot.onText(cmd("account"), async (msg) => {
  const uid = senderId(msg);
  if (!await checkMembership(msg)) return;

  try {
    let user = await getOrCreateUser(uid);
    const updates = {};
    if (needsDailyReset(user.lastReset)) { updates.requests = 0; updates.lastReset = new Date(); }
    if (needsDailyReset(user.tokensReset)) { updates.tokensUsed = 0; updates.tokensReset = new Date(); }
    if (Object.keys(updates).length) {
      user = await User.findOneAndUpdate({ chatId: cid(uid) }, { $set: updates }, { new: true });
    }

    await hydrateUserPrefs(uid);
    const lang = userLanguages.get(cid(uid)) || user.language || "en";
    const model = userModels.get(cid(uid)) || user.selectedModel || "gemini_1";
    const usage = getUsageBucket(uid);
    const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);

    await safeReply(msg,
      `👤 *My Account*\n${LINE}\n\n` +
      `📊 *Daily Usage*\n` +
      `Requests — *${user.requests}* / ${CFG.DAILY_REQUEST_LIMIT}\n` +
      `${progressBar(user.requests, CFG.DAILY_REQUEST_LIMIT)}\n` +
      `Tokens — *${user.tokensUsed}* / ${CFG.DAILY_TOKEN_LIMIT}\n` +
      `${progressBar(user.tokensUsed, CFG.DAILY_TOKEN_LIMIT)}\n` +
      `_Resets in ${fmtDuration(reset - Date.now())}_\n\n` +
      `📁 *Files Today*\n` +
      `Documents — ${usage.doc || 0} / ${CFG.DOC_LIMIT}\n` +
      `Photos — ${usage.img || 0} / ${CFG.IMG_LIMIT}\n` +
      (MODELS.pro ? `Pro model — ${usage.proTokens || 0} / ${CFG.PRO_LIMIT}\n` : ``) +
      `\n⚙️ *Preferences*\n` +
      `Language — ${LANGUAGES[lang] || lang}\n` +
      `Model — ${escapeMarkdown(MODELS[model]?.name || model)}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("account error:", err.message);
    await safeReply(msg, "⚠️ Could not load your account info. Please try again.");
  }
});

function buildLanguageKeyboard(current) {
  const buttons = Object.entries(LANGUAGES).map(([code, name]) => ({
    text: code === current ? `✅ ${name}` : name,
    callback_data: `lang_${code}`,
  }));
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
  return keyboard;
}

function buildModelKeyboard(current) {
  return Object.entries(MODELS).map(([id, m]) => {
    let label = id === "pro" ? `${m.name} ⭐ Pro` : m.name;
    if (id === current) label = `✅ ${label}`;
    return [{
      text: m.key ? label : `${label} ❌`,
      callback_data: m.key ? `model_${id}` : `unavailable_${id}`,
    }];
  });
}

bot.onText(cmd("language"), async (msg) => {
  if (!await checkMembership(msg)) return;
  const uid = senderId(msg);
  await hydrateUserPrefs(uid);
  const current = userLanguages.get(cid(uid)) || "en";

  await safeReply(msg, `🌐 *Choose AI Language*`, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buildLanguageKeyboard(current) },
  });
});

bot.onText(cmd("setmodel"), async (msg) => {
  if (!await checkMembership(msg)) return;
  const uid = senderId(msg);
  await hydrateUserPrefs(uid);
  const current = userModels.get(cid(uid)) || "gemini_1";

  await safeReply(msg, `🧠 *Select AI Model*`, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buildModelKeyboard(current) },
  });
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const uid = query.from?.id ?? chatId;
  const data = query.data || "";

  const refreshKeyboard = async (keyboard, title) => {
    const opts = { chat_id: chatId, message_id: query.message.message_id };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: keyboard }, opts);
        return;
      } catch (err) {
        const m = err?.message || "";
        if (m.includes("message is not modified")) return;
        if (attempt === 0) {
          const wait = (err?.response?.body?.parameters?.retry_after || 1) * 1000;
          await new Promise(r => setTimeout(r, Math.min(wait, 5000)));
          continue;
        }
        try {
          await bot.sendMessage(chatId, title, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard },
          });
          bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
        } catch { }
      }
    }
  };

  if (data.startsWith("lang_")) {
    const lang = data.slice(5);
    if (!LANGUAGES[lang]) {
      bot.answerCallbackQuery(query.id).catch(() => { });
      return;
    }
    await hydrateUserPrefs(uid);
    const current = userLanguages.get(cid(uid)) || "en";

    if (lang === current) {
      bot.answerCallbackQuery(query.id, { text: `Already using ${LANGUAGES[lang]}` }).catch(() => { });
      await refreshKeyboard(buildLanguageKeyboard(current), "🌐 *Choose AI Language*");
      return;
    }

    userLanguages.set(cid(uid), lang);
    User.findOneAndUpdate({ chatId: cid(uid) }, { $set: { language: lang } }, { upsert: true }).catch(() => { });
    bot.answerCallbackQuery(query.id, { text: "✅ Language changed" }).catch(() => { });
    await refreshKeyboard(buildLanguageKeyboard(lang), "🌐 *Choose AI Language*");
    return;
  }

  if (data.startsWith("model_")) {
    const modelId = data.slice(6);
    if (!MODELS[modelId]?.key) {
      bot.answerCallbackQuery(query.id, { text: "⚠️ Model not available.", show_alert: true }).catch(() => { });
      return;
    }
    await hydrateUserPrefs(uid);
    const current = userModels.get(cid(uid)) || "gemini_1";

    if (modelId === current) {
      bot.answerCallbackQuery(query.id, { text: "Already using this model" }).catch(() => { });
      await refreshKeyboard(buildModelKeyboard(current), "🧠 *Select AI Model*");
      return;
    }

    userModels.set(cid(uid), modelId);
    User.findOneAndUpdate({ chatId: cid(uid) }, { $set: { selectedModel: modelId } }, { upsert: true }).catch(() => { });
    bot.answerCallbackQuery(query.id, { text: "✅ Model changed" }).catch(() => { });
    await refreshKeyboard(buildModelKeyboard(modelId), "🧠 *Select AI Model*");
    return;
  }

  if (data === "verify_membership") {
    const userId = query.from.id;
    membershipCache.delete(cid(userId));
    const joined = await isUserMember(userId);
    if (joined) {
      bot.answerCallbackQuery(query.id, { text: "✅ Verified! You can now use the bot.", show_alert: false }).catch(() => { });
      await bot.editMessageText(
        `✅ @${query.from.username || query.from.first_name} is verified! You can now use the bot.`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: [] },
        }
      ).catch(() => { });
    } else {
      bot.answerCallbackQuery(query.id, { text: "❌ You haven't joined yet. Please join the channel first.", show_alert: true }).catch(() => { });
    }
    return;
  }

  if (data.startsWith("unavailable_")) {
    bot.answerCallbackQuery(query.id, { text: "⚠️ Model not available.", show_alert: true }).catch(() => { });
    return;
  }

  bot.answerCallbackQuery(query.id).catch(() => { });
});

bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const uid = senderId(msg);
  if (!await checkMembership(msg)) return;
  if (!await guardAccess(msg)) return;
  if (!await guardRateLimitMedia(msg)) return;
  if (isProcessing(uid)) {
    return safeReply(msg, "⏳ Your previous request is still in progress.");
  }
  if (!hasQuotaLeft(uid, "doc", CFG.DOC_LIMIT)) {
    return safeReply(msg, `⚠️ Daily document limit reached (${CFG.DOC_LIMIT}). Try again tomorrow.`);
  }

  const fileName = (msg.document.file_name || "").toLowerCase();
  const caption = (msg.caption || "").trim().slice(0, 1000);
  if (![".pdf", ".docx", ".txt"].some(ext => fileName.endsWith(ext))) {
    return safeReply(msg, `⚠️ *Unsupported file*\nPlease send a *PDF, DOCX or TXT* file _(max ${CFG.MAX_FILE_MB} MB)_.`,
      { parse_mode: "Markdown" }
    );
  }

  markProcessing(uid);
  try {
    await enqueueRequest(async () => {
      await withThinkingIndicator(chatId, "📄 Analysing your document, please wait…", async () => {
        let fileBuffer;
        try {
          fileBuffer = await downloadFile(msg.document.file_id);
        } catch (err) {
          if (err.message?.startsWith("FILE_TOO_LARGE"))
            return safeReply(msg, `⚠️ File too large. Max: ${CFG.MAX_FILE_MB} MB.`);
          throw err;
        }

        let text = "";
        if (fileName.endsWith(".pdf")) {
          const data = await withTimeout(pdf(fileBuffer), CFG.API_TIMEOUT_MS, "pdf-parse");
          text = data.text;
        } else if (fileName.endsWith(".docx")) {
          const data = await withTimeout(mammoth.extractRawText({ buffer: fileBuffer }), CFG.API_TIMEOUT_MS, "mammoth");
          text = data.value;
        } else {
          text = fileBuffer.toString("utf-8");
        }
        fileBuffer = null;

        if (!text.trim()) return safeReply(msg, "⚠️ No readable text found.");
        if (text.length > CFG.DOC_CHAR_LIMIT) text = text.slice(0, CFG.DOC_CHAR_LIMIT);

        await hydrateUserPrefs(uid);
        const lang = userLanguages.get(cid(uid)) || "en";
        const selectedId = userModels.get(cid(uid)) || "gemini_1";
        const chosen = MODELS[selectedId];

        const langName = `${LANGUAGES[lang] || "English"} (${lang})`;
        const prompt = caption
          ? `Answer the user's question about the document below, based on its content. If the document does not contain the answer, say so. Answer in ${langName}.\n${CFG.STYLE_PROMPT}\n\nQuestion: ${caption}\n\nDocument:\n${text}`
          : `Summarize this document briefly: the main point first, then only the key takeaways. Answer in ${langName}.\n${CFG.STYLE_PROMPT}\n\nDocument:\n${text}`;
        const { user, inputTokens } = await reserveQuota(uid, prompt);

        const { reply, chosen: usedModel, truncated } = await callModel(uid, chosen, prompt);

        await commitLimit(uid, "doc");

        const footer = await finalizeUsage(uid, user, inputTokens, reply, usedModel);
        await appendChatHistory(
          uid,
          `[Document: ${msg.document.file_name || "file"}] ${caption || "Summarize this document"}`,
          reply, truncated
        );
        await sendAIReply(chatId, caption ? "📄 Document Answer:" : "📄 Document Summary:", reply, truncated, footer);
      });
    });
  } catch (err) {
    console.error("❌ Document error:", err.message);
    await safeReply(msg, err.message === "QUEUE_FULL"
      ? "⚠️ Bot is busy. Please try again in a moment."
      : err.message === "DAILY_REQUEST_LIMIT"
        ? `⚠️ Daily request limit (${CFG.DAILY_REQUEST_LIMIT}) reached. Try again tomorrow.`
        : err.message === "DAILY_TOKEN_LIMIT"
          ? `⚠️ Daily token limit (${CFG.DAILY_TOKEN_LIMIT}) reached. Try again tomorrow.`
          : err.message?.startsWith("PRO_LIMIT")
            ? "⚠️ Pro model daily limit reached. Use /setmodel."
            : err.message === "NO_KEY"
              ? "⚠️ Model unavailable. Use /setmodel."
              : err.message?.startsWith("TIMEOUT")
                ? "⚠️ Analysis timed out. Try a smaller file."
                : err.message?.toLowerCase().includes("file is too big")
                  ? `⚠️ File too large. Max: ${CFG.MAX_FILE_MB} MB.`
                  : "⚠️ Could not analyse your document."
    );
  } finally {
    unmarkProcessing(uid);
  }
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const uid = senderId(msg);

  if (msg.media_group_id) {
    if (albumSeen.has(msg.media_group_id)) return;
    albumSeen.set(msg.media_group_id, Date.now());
    setTimeout(() => albumSeen.delete(msg.media_group_id), 5000);
  }

  if (!await checkMembership(msg)) return;
  if (!await guardAccess(msg)) return;
  if (!await guardRateLimitMedia(msg)) return;
  if (isProcessing(uid)) {
    return safeReply(msg, "⏳ Your previous request is still in progress.");
  }
  if (!hasQuotaLeft(uid, "img", CFG.IMG_LIMIT)) {
    return safeReply(msg, `⚠️ Daily image analysis limit reached (${CFG.IMG_LIMIT}). Try again tomorrow.`);
  }

  const photo = msg.photo[msg.photo.length - 1];
  const caption = (msg.caption || "").trim().slice(0, 1000);
  markProcessing(uid);
  try {
    await enqueueRequest(async () => {
      await withThinkingIndicator(chatId, "🖼️ Analysing your image, please wait…", async () => {
        let fileBuffer;
        try {
          fileBuffer = await downloadFile(photo.file_id);
        } catch (err) {
          if (err.message?.startsWith("FILE_TOO_LARGE"))
            return safeReply(msg, `⚠️ Image too large. Max: ${CFG.MAX_FILE_MB} MB.`);
          throw err;
        }

        const base64Image = fileBuffer.toString("base64");
        fileBuffer = null;

        await hydrateUserPrefs(uid);
        const lang = userLanguages.get(cid(uid)) || "en";
        const selectedId = userModels.get(cid(uid)) || "gemini_1";
        const chosen = MODELS[selectedId];
        const langName = `${LANGUAGES[lang] || "English"} (${lang})`;
        const instruction = caption
          ? `The user sent this image with a question or instruction. Answer it based on the image. Answer in ${langName}.\n${CFG.STYLE_PROMPT}\n\nUser's question: ${caption}`
          : `Describe this image concisely: what it shows and anything important in it. Answer in ${langName}.\n${CFG.STYLE_PROMPT}`;

        const { user, inputTokens } = await reserveQuota(uid, instruction);

        const { reply, chosen: usedModel, truncated } = await callVisionModel(
          uid, chosen, base64Image, "image/jpeg", instruction
        );

        await commitLimit(uid, "img");

        const footer = await finalizeUsage(uid, user, inputTokens, reply, usedModel);
        await appendChatHistory(uid, `[Image] ${caption || "Describe this image"}`, reply, truncated);
        await sendAIReply(chatId, caption ? "🖼️ Image Answer:" : "🖼️ Image Analysis:", reply, truncated, footer);
      });
    });
  } catch (err) {
    console.error("❌ Image analysis error:", err.message);
    await safeReply(msg, err.message === "QUEUE_FULL"
      ? "⚠️ Bot is busy. Please try again in a moment."
      : err.message === "DAILY_REQUEST_LIMIT"
        ? `⚠️ Daily request limit (${CFG.DAILY_REQUEST_LIMIT}) reached. Try again tomorrow.`
        : err.message === "DAILY_TOKEN_LIMIT"
          ? `⚠️ Daily token limit (${CFG.DAILY_TOKEN_LIMIT}) reached. Try again tomorrow.`
          : err.message?.startsWith("PRO_LIMIT")
            ? "⚠️ Pro model daily limit reached. Use /setmodel."
            : err.message === "NO_KEY"
              ? "⚠️ Model unavailable. Use /setmodel."
              : err.message?.startsWith("TIMEOUT")
                ? "⚠️ Analysis timed out. Try a smaller image."
                : err.message?.toLowerCase().includes("file is too big")
                  ? `⚠️ Image too large. Max: ${CFG.MAX_FILE_MB} MB.`
                  : "⚠️ Could not analyse your image."
    );
  } finally {
    unmarkProcessing(uid);
  }
});

const LEGACY_BUTTONS = new Set(["🔍 Search", "🎨 Imagine", "🚫 Report Error", "📄 Document Analysis"]);

async function runAiPipeline(msg, text) {
  const chatId = msg.chat.id;
  const uid = senderId(msg);

  if (!await checkMembership(msg)) return;
  if (!await guardAccess(msg)) return;
  if (!await guardRateLimit(msg)) return;

  if (/^https?:\/\//i.test(text.trim())) {
    return safeReply(msg, "⚠️ Links are not allowed.");
  }

  if (LEGACY_BUTTONS.has(text)) {
    return safeSend(msg.chat.id,
      `🧹 *Menu buttons removed*\nSend /help to see everything I can do.`,
      { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
    );
  }

  if (isProcessing(uid)) {
    return safeReply(msg, "⏳ Your previous request is still in progress. Please wait.");
  }

  markProcessing(uid);
  try {
    await enqueueRequest(async () => {
      let quota;
      try {
        quota = await reserveQuota(uid, text);
      } catch (err) {
        if (err.message === "DAILY_REQUEST_LIMIT") return safeReply(msg, `⚠️ Daily request limit (${CFG.DAILY_REQUEST_LIMIT}) reached. Try again tomorrow.`);
        if (err.message === "DAILY_TOKEN_LIMIT") return safeReply(msg, `⚠️ Daily token limit (${CFG.DAILY_TOKEN_LIMIT}) reached. Try again tomorrow.`);
        throw err;
      }
      const { user, inputTokens } = quota;

      await hydrateUserPrefs(uid);
      const lang = userLanguages.get(cid(uid)) || "en";

      const history = await getRecentHistory(uid);

      let aiResult;
      try {
        aiResult = await withThinkingIndicator(chatId, "🤔 Thinking…", () => getAIReply(uid, text, history, lang));
      } catch (err) {
        if (err.message?.startsWith("PRO_LIMIT")) return safeReply(msg, `⚠️ Pro model daily limit reached. Use /setmodel.`);
        if (err.message === "NO_KEY") return safeReply(msg, "⚠️ Model unavailable. Use /setmodel.");
        if (err.message?.startsWith("TIMEOUT")) return safeReply(msg, "⚠️ AI took too long to respond. Try again.");
        throw err;
      }

      const { reply, chosen, truncated } = aiResult;

      let footer;
      try {
        footer = await finalizeUsage(uid, user, inputTokens, reply, chosen);
      } catch (err) {
        if (err.message === "DAILY_TOKEN_LIMIT") return safeReply(msg, "⚠️ Reply would exceed daily token limit. Try again tomorrow.");
        throw err;
      }

      await appendChatHistory(uid, text, reply, truncated);

      await sendAIReply(chatId, "", reply, truncated, footer);
    });
  } catch (err) {
    if (err.message === "QUEUE_FULL") {
      return safeReply(msg, "⚠️ Bot is very busy. Please try again shortly.");
    }
    console.error("❌ Chat error:", err.message);
    await safeReply(msg, "❌ Something went wrong. Please try again.");
  } finally {
    unmarkProcessing(uid);
  }
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (msg.photo || msg.document) return;

  if (!text) {
    const UNSUPPORTED = ["voice", "video", "video_note", "audio", "sticker", "animation", "contact", "location", "venue", "poll"];
    const kind = UNSUPPORTED.find(t => msg[t]);
    if (kind) {
      if (!await checkMembership(msg)) return;
      return safeSend(chatId,
        `⚠️ *Unsupported message*\n${LINE}\n` +
        `I can't process *${kind.replace("_", " ")}* messages.\n` +
        `Please send text, a *PDF / DOCX / TXT* file, or a *photo*.`,
        { parse_mode: "Markdown" }
      );
    }
    return;
  }

  if (text.startsWith("/")) return;

  await runAiPipeline(msg, text);
});

// ============================================================
//  ADMIN COMMANDS
// ============================================================
bot.onText(/^\/admin(?:@\w+)?\s*$/, async (msg) => {
  if (msg.chat.id !== CFG.ADMIN_ID) return;
  await safeSend(CFG.ADMIN_ID,
    `🎧 <b>Admin Panel</b>\n${LINE}\n\n` +
    `📣 <b>Messaging</b>\n` +
    `/broadcast <i>message to bot users</i>\n\n` +
    `👥 <b>Users</b>\n` +
    `/users — list approved users\n` +
    `/approve <i>id</i> <i>hours</i>\n` +
    `/remove <i>id</i>\n` +
    `/banned — list banned users\n` +
    `/ban <i>id</i> <i>reason</i>\n` +
    `/unban <i>id</i>\n\n` +
    `🔐 <b>Access Mode</b>\n` +
    `/private — approved users only\n` +
    `/public — open to everyone\n` +
    `/mode — <i>(now: ${PUBLIC_MODE ? "PUBLIC" : "PRIVATE"})</i>\n\n` +
    `📊 <b>Reports</b>\n` +
    `/usage — today's usage summary`,
    { parse_mode: "HTML" }
  );
});

bot.onText(/^\/broadcast(?:@\w+)?(?:\s+([\s\S]*))?$/i, async (msg, match) => {
  if (msg.chat.id !== CFG.ADMIN_ID) return;

  const message = (match[1] || "").trim();
  if (!message) {
    return bot.sendMessage(CFG.ADMIN_ID,
      `⚠️ Usage: /broadcast <message>\n\n` +
      `Example:\n` +
      `/broadcast Maintenance tonight at 10 PM UTC\n\n` +
      `Sends the message to every non-banned user in the database.`
    ).catch(() => { });
  }

  bot.sendMessage(CFG.ADMIN_ID, "📡 Broadcast starting…").catch(() => { });
  try {
    const { success, failed } = await broadcastMessage(message);
    bot.sendMessage(CFG.ADMIN_ID, `✅ Done.\n✔️ Sent: ${success}\n❌ Failed: ${failed}`).catch(() => { });
  } catch (err) {
    console.error("broadcast error:", err.message);
    bot.sendMessage(CFG.ADMIN_ID, "⚠️ Broadcast failed.").catch(() => { });
  }
});

bot.onText(cmd("usage"), async (msg) => {
  if (msg.chat.id !== CFG.ADMIN_ID) return;
  try {
    const today = utcToday();
    const stats = await DailyStats.findOne({ date: today });
    const totalUsers = await User.countDocuments();

    const report =
      `📊 *Daily Summary* (${today})\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👥 Total users in DB: ${totalUsers}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📨 Requests today:  ${stats?.requests || 0}\n` +
      `🪙 Tokens today:    ${stats?.tokens || 0}\n` +
      `📄 Docs today:      ${stats?.doc || 0}\n` +
      `🖼️ Img analyses:    ${stats?.img || 0}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `_(resets at UTC midnight)_`;

    bot.sendMessage(CFG.ADMIN_ID, report, { parse_mode: "Markdown" }).catch(() => { });
  } catch (err) {
    console.error("usage error:", err.message);
    bot.sendMessage(CFG.ADMIN_ID, "⚠️ Could not generate usage report.").catch(() => { });
  }
});

bot.onText(cmd("users"), async (msg) => {
  if (msg.chat.id !== CFG.ADMIN_ID) return;
  try {
    const users = await User.find({ approvedUntil: { $gt: new Date() } }, { chatId: 1, approvedUntil: 1 });
    if (!users.length) return bot.sendMessage(CFG.ADMIN_ID, "📭 No active approved users.").catch(() => { });

    let text = "👥 *Approved Users*\n━━━━━━━━━━━━━\n";
    users.forEach((u, i) => {
      const rem = Math.max(0, Math.ceil((new Date(u.approvedUntil) - Date.now()) / 3600000)) + "h";
      text += `${i + 1}. \`${u.chatId}\` — ⏳ ${rem}\n`;
    });
    bot.sendMessage(CFG.ADMIN_ID, text, { parse_mode: "Markdown" }).catch(() => { });
  } catch (err) {
    console.error("users error:", err.message);
    bot.sendMessage(CFG.ADMIN_ID, "⚠️ Could not list users.").catch(() => { });
  }
});

const MAX_APPROVAL_HOURS = 24 * 365;

bot.onText(/^\/approve(?:@\w+)?(?:\s+([\s\S]*))?$/i, async (msg, match) => {
  if (msg.chat.id !== CFG.ADMIN_ID) return;

  const [userId, hoursArg, ...extra] = (match[1] || "").trim().split(/\s+/).filter(Boolean);
  const hoursOk = hoursArg === undefined || /^\d+(\.\d+)?$/.test(hoursArg);
  const hours = hoursArg === undefined ? CFG.APPROVAL_HOURS : Number(hoursArg);

  if (!/^\d+$/.test(userId || "") || extra.length || !hoursOk || !(hours > 0) || hours > MAX_APPROVAL_HOURS) {
    return bot.sendMessage(CFG.ADMIN_ID,
      `⚠️ Usage: /approve <id> [hours]\n\n` +
      `• <id> — numeric Telegram user id (required)\n` +
      `• [hours] — access duration, optional (default ${CFG.APPROVAL_HOURS}h, max ${MAX_APPROVAL_HOURS}h)\n\n` +
      `Examples:\n` +
      `/approve 123456789 → ${CFG.APPROVAL_HOURS} hours (default)\n` +
      `/approve 123456789 72 → 72 hours\n` +
      `/approve 123456789 0.5 → 30 minutes\n\n` +
      `Approving a user again replaces their current expiry.`
    ).catch(() => { });
  }

  try {
    const existing = await User.findOne({ chatId: userId }, { banned: 1 }).lean();
    if (existing?.banned) {
      return bot.sendMessage(CFG.ADMIN_ID, `🚫 User ${userId} is banned. Run /unban ${userId} first.`).catch(() => { });
    }

    const expiresAt = new Date(Date.now() + hours * 3600000);
    await User.findOneAndUpdate(
      { chatId: userId },
      { $set: { approvedUntil: expiresAt } },
      { upsert: true }
    );
    approvalCache.delete(userId);
    bot.sendMessage(CFG.ADMIN_ID,
      `✅ User ${userId} approved for ${fmtDuration(hours * 3600000)}\n⏳ Until ${expiresAt.toUTCString()}`
    ).catch(() => { });
  } catch (err) {
    console.error("approve error:", err.message);
    bot.sendMessage(CFG.ADMIN_ID, "⚠️ Could not approve user.").catch(() => { });
  }
});

bot.onText(/^\/remove(?:@\w+)?(?:\s+([\s\S]*))?$/i, async (msg, match) => {
  if (msg.chat.id !== CFG.ADMIN_ID) return;

  const userId = (match[1] || "").trim();
  if (!/^\d+$/.test(userId)) {
    return bot.sendMessage(CFG.ADMIN_ID,
      `⚠️ Usage: /remove <id>\n\n` +
      `Example:\n` +
      `/remove 123456789\n\n` +
      `Revokes the user's approved access. Use /users to see approved ids.`
    ).catch(() => { });
  }

  try {
    const res = await User.findOneAndUpdate({ chatId: userId }, { $set: { approvedUntil: null } });
    approvalCache.delete(userId);
    bot.sendMessage(CFG.ADMIN_ID,
      res ? `❌ User ${userId} removed.` : `ℹ️ User ${userId} isn't in the database.`
    ).catch(() => { });
  } catch (err) {
    console.error("remove error:", err.message);
    bot.sendMessage(CFG.ADMIN_ID, "⚠️ Could not remove user.").catch(() => { });
  }
});

bot.onText(/^\/ban(?:@\w+)?(?:\s+([\s\S]*))?$/i, async (msg, match) => {
  if (msg.chat.id !== CFG.ADMIN_ID) return;

  const m = (match[1] || "").trim().match(/^(\d+)(?:\s+([\s\S]+))?$/);
  if (!m) {
    return bot.sendMessage(CFG.ADMIN_ID, "⚠️ Usage: /ban <id> [reason]").catch(() => { });
  }
  const userId = m[1];
  const reason = (m[2] || "").trim().slice(0, 200);

  if (Number(userId) === CFG.ADMIN_ID) {
    return bot.sendMessage(CFG.ADMIN_ID, "⚠️ You can't ban yourself.").catch(() => { });
  }

  try {
    await User.findOneAndUpdate(
      { chatId: userId },
      { $set: { banned: true, bannedAt: new Date(), banReason: reason, approvedUntil: null } },
      { upsert: true }
    );
    approvalCache.delete(userId);
    banCache.set(userId, { banned: true, expiry: Date.now() + CFG.APPROVAL_CACHE_TTL });
    bot.sendMessage(CFG.ADMIN_ID, `🚫 User ${userId} banned.${reason ? `\nReason: ${reason}` : ""}`).catch(() => { });
  } catch (err) {
    console.error("ban error:", err.message);
    bot.sendMessage(CFG.ADMIN_ID, "⚠️ Could not ban user.").catch(() => { });
  }
});

bot.onText(/^\/unban(?:@\w+)?(?:\s+([\s\S]*))?$/i, async (msg, match) => {
  if (msg.chat.id !== CFG.ADMIN_ID) return;

  const userId = (match[1] || "").trim();
  if (!/^\d+$/.test(userId)) {
    return bot.sendMessage(CFG.ADMIN_ID, "⚠️ Usage: /unban <id>").catch(() => { });
  }

  try {
    const res = await User.findOneAndUpdate(
      { chatId: userId },
      { $set: { banned: false, bannedAt: null, banReason: "" } }
    );
    banCache.delete(userId);
    bot.sendMessage(CFG.ADMIN_ID,
      res ? `♻️ User ${userId} unbanned.\nUse /approve ${userId} if they also need access.`
        : `ℹ️ User ${userId} isn't in the database.`
    ).catch(() => { });
  } catch (err) {
    console.error("unban error:", err.message);
    bot.sendMessage(CFG.ADMIN_ID, "⚠️ Could not unban user.").catch(() => { });
  }
});

bot.onText(cmd("banned"), async (msg) => {
  if (msg.chat.id !== CFG.ADMIN_ID) return;
  try {
    const users = await User.find({ banned: true }, { chatId: 1, banReason: 1 })
      .sort({ bannedAt: -1 }).limit(100).lean();
    if (!users.length) return bot.sendMessage(CFG.ADMIN_ID, "📭 No banned users.").catch(() => { });

    let text = `🚫 Banned Users (${users.length})\n━━━━━━━━━━━━━\n`;
    users.forEach((u, i) => { text += `${i + 1}. ${u.chatId}${u.banReason ? ` — ${u.banReason}` : ""}\n`; });
    await sendLongMessage(CFG.ADMIN_ID, text);
  } catch (err) {
    console.error("banned list error:", err.message);
    bot.sendMessage(CFG.ADMIN_ID, "⚠️ Could not list banned users.").catch(() => { });
  }
});

bot.onText(cmd("public"), async (msg) => {
  if (msg.chat.id !== CFG.ADMIN_ID) return;
  try {
    PUBLIC_MODE = true;
    await Setting.findOneAndUpdate({ key: "publicMode" }, { $set: { value: true } }, { upsert: true });
    bot.sendMessage(CFG.ADMIN_ID, "🔓 Bot is now PUBLIC. (Persisted)").catch(() => { });
  } catch (err) {
    console.error("public mode error:", err.message);
    bot.sendMessage(CFG.ADMIN_ID, "⚠️ Could not save setting.").catch(() => { });
  }
});

bot.onText(cmd("private"), async (msg) => {
  if (msg.chat.id !== CFG.ADMIN_ID) return;
  try {
    PUBLIC_MODE = false;
    await Setting.findOneAndUpdate({ key: "publicMode" }, { $set: { value: false } }, { upsert: true });
    bot.sendMessage(CFG.ADMIN_ID, "🔒 Bot is now PRIVATE. (Persisted)").catch(() => { });
  } catch (err) {
    console.error("private mode error:", err.message);
    bot.sendMessage(CFG.ADMIN_ID, "⚠️ Could not save setting.").catch(() => { });
  }
});

bot.onText(cmd("mode"), (msg) => {
  if (msg.chat.id !== CFG.ADMIN_ID) return;
  bot.sendMessage(CFG.ADMIN_ID, PUBLIC_MODE ? "🔓 Mode: PUBLIC" : "🔒 Mode: PRIVATE").catch(() => { });
});

startup().catch(err => {
  console.error("❌ Fatal startup error:", err.message);
  process.exit(1);
});
