# 🤖 AI Assistant Telegram Bot

A private AI assistant on Telegram supporting **Gemini, OpenAI, Claude** and any OpenAI-compatible provider (Groq, OpenRouter, DeepSeek, Mistral, Together). Includes user management (MongoDB), usage limits, and Public/Private access modes.

---

## ✨ Features

* **🧠 Multi-Model:** Add any number of free/pro models from any provider, **directly from Telegram**, with no redeploy.
* **💬 Smart Chat:** Context-aware replies with short-term memory.
* **👁️ Image Vision:** Ask questions about photos (vision-enabled models).
* **📄 Document Analysis:** Summarize PDF, DOCX, and TXT files.
* **🛡️ Admin Controls:** Public/Private mode, approvals, bans, broadcast, usage reports.
* **📉 Rate Limiting:** Daily limits for requests, tokens, documents, images, and pro models.
* **⚠️ Friendly Errors:** If a model is busy or fails, users are told to switch with `/setmodel`.

---

## 🛠️ Prerequisites

1. **Node.js** v18+
2. **MongoDB** ([free Atlas cluster](https://www.mongodb.com/atlas))
3. **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)
4. **At least one AI provider API key**

---

## 🚀 Setup

1. Rename `.env.example` to `.env` and fill it in. Required: `TELEGRAM_TOKEN`, `ADMIN_ID`, `MONGODB_CONNECT`, `RENDER_URL`, plus at least one provider API key.
2. Install and start:

        npm install
        npm start

   *Webhooks need a public HTTPS URL. Use **ngrok** for local testing.*

---

## ☁️ Deploy (Render.com)

1. Push to GitHub, then create a new **Web Service** on Render.
2. **Build:** `npm install` · **Start:** `npm start`
3. Add all `.env` values as environment variables. Set `RENDER_URL` to your Render URL.
4. Deploy. The webhook is set automatically.

---

## 🧠 Managing Models (Admin)

API keys live in `.env`. **Model names are managed in Telegram** (stored in MongoDB). On first start, defaults from `config/defaultModels.js` are loaded, so edit the model names there before the first run.

        /addmodel <id> <provider> <free|pro> <vision yes|no> <model-name> [label]
        /addmodel gem-flash gemini free yes gemini-2.5-flash Gemini Flash

Providers: `gemini`, `openai`, `claude`, `groq`, `openrouter`, `deepseek`, `mistral`, `together`.

**Adding a new provider:**
* *OpenAI-compatible:* add one line in `config/providers.js`, add its key to `.env`, restart.
* *Custom API:* also add an adapter in `providers/` and register it in `providers/index.js`.

---

## 🎮 Commands

### 👤 User

| Command | Description |
| :--- | :--- |
| `/start` | Start the bot. |
| `/help` | List commands. |
| `/setmodel` | Choose AI model (⭐ pro, 🖼 vision). |
| `/account` | Usage and limits. |
| `/language` | Change reply language. |
| `/clearchat` | Clear chat memory. |
| `/status` | Check access. |

### 👮 Admin (only `ADMIN_ID`)

| Command | Description |
| :--- | :--- |
| `/admin` | Admin panel. |
| `/broadcast <msg>` | Message all users. |
| `/usage` | Today's usage report. |
| `/users` | List approved users. |
| `/approve <id> [hours]` | Grant access (default 24h). |
| `/remove <id>` | Revoke access. |
| `/ban <id> [reason]` / `/unban <id>` / `/banned` | Manage bans. |
| `/public` / `/private` / `/mode` | Access mode. |
| `/models` | List models and key status. |
| `/addmodel` | Add or update a model. |
| `/removemodel <id>` | Delete a model. |
| `/togglemodel <id>` | Enable or disable a model. |
| `/testmodel <id>` | Send a test prompt to a model. |

---

## 📂 Project Structure

```
bot.js                    Main entry (Telegram logic)
config/providers.js       Providers and their API-key env names
config/defaultModels.js   Models seeded on first start
services/modelRegistry.js Model storage (MongoDB) and lookup
providers/                Gemini / OpenAI / Anthropic adapters + error handling
views/                    EJS pages (home, privacy, terms)
.env                      API keys and settings
```

---

## 📜 License & Terms

For educational and personal use.
* **Privacy:** Chat history is stored in MongoDB for context and can be cleared with `/clearchat`.
* **AI Disclaimer:** Responses may be inaccurate.

---

**Made with ❤️ by Aman**