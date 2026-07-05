# bro-server

Лёгкий Express-прокси к DeepSeek API (OpenAI-совместимый формат chat/completions). Ключ живёт только здесь, в `.env`, и никогда не попадает в клиентский бандл.

## Запуск

```bash
cd server
npm install
cp .env.example .env
# впиши DEEPSEEK_API_BASE_URL и DEEPSEEK_API_KEY в .env
npm run dev
```

Сервер поднимется на `http://localhost:8787`. Vite dev-сервер (фронтенд) проксирует `/api/*` сюда автоматически (см. `vite.config.ts`).

Никакого кастомного TLS не требуется — обычный `fetch` на стандартном системном доверенном хранилище сертификатов.

## Эндпоинты

- `POST /api/chat` — `{ messages: [{role, content}], memory: string[] }` → стримит ответ бро через SSE (`data: {"text": "..."}` чанки, завершается `data: {"done": true}`). Внутри вызывает DeepSeek `chat/completions` со `stream: true` на модели `DEEPSEEK_CHAT_MODEL` и переупаковывает его SSE в этот простой формат.
- `POST /api/memory/extract` — `{ exchange: { user, bro } }` → `{ facts: string[] }`, 0-2 коротких факта или пустой массив. Всегда на модели `DEEPSEEK_MEMORY_MODEL` (самый дешёвый тир), независимо от того, какая модель стоит на чате.
- `GET /api/health` — проверяет, что ключ и base URL настроены и по ним реально отвечает `/models`.

## Модели

Две независимые переменные:

- `DEEPSEEK_CHAT_MODEL` — модель для обычного разговора с бро. По умолчанию `deepseek-v4-flash`, можно переключить на pro-тир одной переменной.
- `DEEPSEEK_MEMORY_MODEL` — модель для извлечения фактов в память. Держи её на самом дешёвом тире (`deepseek-v4-flash`) даже если чат апгрейднут — это лёгкая фоновая задача, ей не нужна топовая модель.
