require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { buildSystemPrompt, CALIBRATION_TOPIC_LABELS } = require('./systemPrompt');
const { deepseekFetch } = require('./deepseek');
const { detectCrisis, getCrisisResponse } = require('./crisisFilter');
const { startPolling } = require('./telegram');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const DEFAULT_MODEL = 'deepseek-v4-flash';
const CHAT_MODEL = process.env.DEEPSEEK_CHAT_MODEL || DEFAULT_MODEL;
// память всегда на самом дешёвом тире, независимо от того, на чём сидит чат
const MEMORY_MODEL = process.env.DEEPSEEK_MEMORY_MODEL || DEFAULT_MODEL;

// клиент хранит и показывает всю историю (до 200 сообщений), но модели каждый
// раз отдаём только последние ~20 — долгосрочный контекст она берёт из фактов
// памяти, а не из перечитывания всего архива на каждый запрос
const MAX_CONTEXT_MESSAGES = 20;

function toChatMessages(messages, memory, calibrating, reconnecting) {
  const system = { role: 'system', content: buildSystemPrompt(memory, calibrating, reconnecting) };
  const rest = messages
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));
  const recent =
    rest.length > MAX_CONTEXT_MESSAGES ? rest.slice(rest.length - MAX_CONTEXT_MESSAGES) : rest;
  return [system, ...recent];
}

// POST /api/chat — стримит ответ бро через SSE в собственном простом формате
// ({text}/{done}/{error}), внутри дергая DeepSeek; ключ остаётся только на сервере
app.post('/api/chat', async (req, res) => {
  const { messages, memory, calibrating, reconnecting } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages обязателен' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  // детерминированный кризисный фильтр — проверяем ПОСЛЕДНЕЕ сообщение
  // пользователя ДО обращения к модели. Если сработало явное совпадение —
  // модель для этого сообщения не вызывается вообще, ответ гарантированно
  // приходит из заранее написанного набора (см. crisisFilter.js)
  const lastUserMessage = [...messages].reverse().find((m) => m && m.role === 'user' && typeof m.content === 'string');
  if (lastUserMessage && detectCrisis(lastUserMessage.content)) {
    console.log(`crisis_filter_triggered: true (len=${lastUserMessage.content.length})`);
    send({ text: getCrisisResponse() });
    send({ done: true });
    res.end();
    return;
  }

  try {
    const upstream = await deepseekFetch('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: toChatMessages(messages, memory, Boolean(calibrating), Boolean(reconnecting)),
        stream: true,
        // CHAT_MODEL — reasoning-модель: часть токенов уходит на скрытые
        // рассуждения (reasoning_content), 512 не хватало на развёрнутый
        // видимый ответ (обрезался на finish_reason: "length")
        max_tokens: 1500,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => upstream.statusText);
      send({ error: errText });
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const evtBlock of events) {
        const line = evtBlock.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;

        if (raw === '[DONE]') {
          send({ done: true });
          continue;
        }

        let evt;
        try {
          evt = JSON.parse(raw);
        } catch {
          continue;
        }

        const choice = evt.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta) {
          send({ text: delta });
        }
        if (choice?.finish_reason) {
          send({ done: true });
        }
      }
    }

    res.end();
  } catch (err) {
    send({ error: String(err && err.message ? err.message : err) });
    res.end();
  }
});

// POST /api/memory/extract — лёгкий вызов на самой дешёвой модели, извлекает
// 0-2 факта о юзере из последнего обмена. Если передан currentTopic (во время
// калибровки) — дополнительно определяет, закрыта ли именно эта тема сейчас
app.post('/api/memory/extract', async (req, res) => {
  const { exchange, currentTopic } = req.body || {};
  if (!exchange || !exchange.user || !exchange.user.trim()) {
    res.json({ facts: [], topicCovered: false });
    return;
  }

  const topicLabel = currentTopic ? CALIBRATION_TOPIC_LABELS[currentTopic] : null;

  const prompt = `Вот последний обмен репликами между человеком и его другом "бро":
Человек: ${exchange.user}
Бро: ${exchange.bro || ''}

Если в реплике человека есть новый короткий факт о нём самом, который стоит запомнить на будущее (имя, обстоятельства, предпочтения, важные события, состояние), выпиши 0-2 таких факта, каждый — короткая фраза от второго лица ("ты..."), без лишних слов. Если запоминать нечего — верни пустой массив.
${
  topicLabel
    ? `Дополнительно: сейчас идёт знакомство, и нужно понять, дал ли человек содержательный ответ ИМЕННО в этой реплике по теме "${topicLabel}". Если да — topicCovered: true, если человек ушёл от темы, не ответил по существу или ответил про другое — topicCovered: false.`
    : 'Поле topicCovered в этом случае всегда false.'
}
Ответь СТРОГО в виде JSON-объекта, без пояснений и без markdown-обрамления, в формате {"facts": [...], "topicCovered": true|false}. Например: {"facts": ["устаёшь от работы по вечерам"], "topicCovered": true} или {"facts": [], "topicCovered": false}.`;

  try {
    const upstream = await deepseekFetch('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: MEMORY_MODEL,
        messages: [{ role: 'user', content: prompt }],
        // MEMORY_MODEL — reasoning-модель: часть токенов уходит на скрытые
        // рассуждения (reasoning_content), 200 не хватало на финальный JSON
        max_tokens: 600,
      }),
    });

    if (!upstream.ok) {
      res.json({ facts: [], topicCovered: false });
      return;
    }

    const data = await upstream.json();
    const text = data?.choices?.[0]?.message?.content ?? '{}';

    let facts = [];
    let topicCovered = false;
    try {
      const parsed = JSON.parse(String(text).trim());
      if (Array.isArray(parsed)) {
        // на случай если модель всё же вернула голый массив (старый формат)
        facts = parsed.filter((f) => typeof f === 'string' && f.trim()).slice(0, 2);
      } else if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.facts)) {
          facts = parsed.facts.filter((f) => typeof f === 'string' && f.trim()).slice(0, 2);
        }
        topicCovered = Boolean(parsed.topicCovered);
      }
    } catch {
      facts = [];
      topicCovered = false;
    }

    res.json({ facts, topicCovered });
  } catch {
    res.json({ facts: [], topicCovered: false });
  }
});

app.get('/api/health', async (_req, res) => {
  const hasKey = Boolean(process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_BASE_URL);
  let keyOk = false;
  if (hasKey) {
    try {
      const r = await deepseekFetch('/models', { method: 'GET' });
      keyOk = r.ok;
    } catch {
      keyOk = false;
    }
  }
  res.json({ ok: true, hasKey, keyOk, chatModel: CHAT_MODEL, memoryModel: MEMORY_MODEL });
});

const PORT = process.env.PORT || 8787;

// Раздача статики фронтенда (собирается в /dist)
app.use(express.static(path.join(__dirname, '../dist')));

// SPA роутинг — любой другой путь отдаёт index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`bro-server (DeepSeek) listening on http://localhost:${PORT}`);
});

// long polling телеграм-бота — независимый фоновый цикл внутри того же
// процесса, не мешает обработке HTTP-запросов (см. server/telegram.js)
startPolling(process.env.TELEGRAM_BOT_TOKEN, process.env.FRONTEND_ORIGIN);
