# бро (bro)

> Your AI friend in Telegram — a companion that remembers what's going on in your life and talks like a friend, not an assistant.

**бро** is a Telegram Mini App (React + Vite frontend, Express backend) featuring:

- **Memory** — long-term facts extracted from your conversations and recalled naturally in later chats
- **Calibration onboarding** — a natural getting-to-know-you flow instead of a form
- **Crisis detection** — if a user is in distress, the assistant switches to real care mode and redirects to a hotline, never attempting to replace professional help
- **Proactive reconnects** — бро can start a conversation first after a long break
- **Referrals** — invite-a-friend program with subscription bonuses
- **Payments** — Telegram Stars subscription via `pre_checkout_query`

## Architecture

```
├── src/                  # React + Vite Telegram Mini App frontend
│   ├── screens/          # Chat, Memory, Settings, Paywall, Consent, HelpNow
│   ├── components/       # BroMascot, TabBar, Splash
│   └── storage.ts        # localStorage-backed memory / history
├── server/               # Express backend (Node, CommonJS)
│   ├── index.js          # API + Telegram long-polling bot + admin stats
│   ├── telegram.js       # Telegram Bot API client (long polling)
│   ├── telegramAuth.js   # Mini App initData signature verification
│   ├── deepseek.js       # thin DeepSeek (OpenAI-compatible) client
│   ├── crisisFilter.js   # crisis keywords / response guard
│   └── systemPrompt.js   # persona + calibration + memory prompts
└── public/               # static assets (favicon)
```

## Getting started

### Prerequisites

- Node.js 18+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A DeepSeek API key (or any OpenAI-compatible provider)

### 1. Server

```bash
cd server
npm install
cp .env.example .env
# fill in DEEPSEEK_API_BASE_URL, DEEPSEEK_API_KEY, TELEGRAM_BOT_TOKEN, FRONTEND_ORIGIN
npm start
```

The server runs on `http://localhost:8787` and serves both the API and (after a build) the static frontend.

### 2. Frontend (dev)

```bash
npm install
npm run dev
```

Vite proxies `/api/*` to the server (see `vite.config.ts`).

### 3. Build

```bash
npm run build
npm start   # server now serves dist/ + API on one port
```

## Environment variables (`server/.env.example`)

| Variable | Description |
| --- | --- |
| `DEEPSEEK_API_BASE_URL` | OpenAI-compatible base URL for chat/completions |
| `DEEPSEEK_API_KEY` | Provider API key (never shipped to the client) |
| `DEEPSEEK_CHAT_MODEL` | Model for regular chat (default `deepseek-v4-flash`) |
| `DEEPSEEK_MEMORY_MODEL` | Model for memory extraction (cheapest tier) |
| `TELEGRAM_BOT_TOKEN` | Bot token for the Mini App + long-polling bot |
| `FRONTEND_ORIGIN` | CORS origin + Mini App URL used in bot buttons |
| `ADMIN_KEY` | Query-key protecting `GET /admin/stats` |
| `DATA_DIR` | Optional — persistent volume for `users.json` / `events.log` |
| `PORT` | Server port (default `8787`) |

## API endpoints

- `POST /api/chat` — streams a bro reply via SSE
- `POST /api/sync` — auth via Telegram `initData`, returns memory/subscription state
- `POST /api/memory/extract` — extracts 0–2 memory facts from an exchange
- `POST /api/payment/invoice` — creates a Telegram Stars invoice
- `GET /api/pending` — pending proactive messages for a user
- `GET /api/health` — provider key + model health check
- `GET /admin/stats` — analytics (protected by `ADMIN_KEY`)

## Safety

The system prompt and `crisisFilter.js` contain hard guardrails:

- Suicide / self-harm / violence signals switch the assistant to immediate care mode and redirect to the Russian hotline **8-800-2000-122**
- The assistant never acts romantic/flirtatious, never impersonates a professional, and never suggests self-harm replacement techniques

## Security notes

- Secrets live only in `server/.env` (gitignored)
- `server/users.json` and `server/events.log` contain user data and are gitignored
- Telegram Mini App auth validates `initData` signatures server-side (`telegramAuth.js`) — the client-provided `tgId` is never trusted directly

## License

MIT © al0xv
