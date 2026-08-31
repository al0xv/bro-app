require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { buildSystemPrompt, CALIBRATION_TOPIC_LABELS } = require('./systemPrompt');
const { deepseekFetch } = require('./deepseek');
const { detectCrisis, getCrisisResponse } = require('./crisisFilter');
const { startPolling, sendMessage, createInvoiceLink, getBotUsername } = require('./telegram');
const { validateInitData } = require('./telegramAuth');

const app = express();
app.set('trust proxy', 1);
// в проде фронтенд и API отдаются с одного домена (см. express.static ниже),
// так что легитимный Mini App всегда same-origin и cors() его не касается —
// ограничение origin'а бьёт только по чужим сайтам, которые дёргают наш API
// напрямую. Если FRONTEND_ORIGIN не задан (локальная разработка) — не режем,
// иначе сломаем сценарии без домена
app.use(cors(process.env.FRONTEND_ORIGIN ? { origin: process.env.FRONTEND_ORIGIN } : undefined));
app.use(express.json({ limit: '1mb' }));

// /api/chat и /api/memory/extract дёргают платный DeepSeek — без лимита
// сервер открыт всему интернету (сейчас реально торчит наружу через туннель),
// и это прямой риск накрутки счёта. Лимит намеренно мягкий (не мешает обычному
// разговору), но режет скриптовый флуд
const chatRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'слишком много запросов, попробуй через минуту' },
});

const DEFAULT_MODEL = 'deepseek-v4-flash';
const CHAT_MODEL = process.env.DEEPSEEK_CHAT_MODEL || DEFAULT_MODEL;
// память всегда на самом дешёвом тире, независимо от того, на чём сидит чат
const MEMORY_MODEL = process.env.DEEPSEEK_MEMORY_MODEL || DEFAULT_MODEL;

// клиент хранит и показывает всю историю (до 200 сообщений), но модели каждый
// раз отдаём только последние ~20 — долгосрочный контекст она берёт из фактов
// памяти, а не из перечитывания всего архива на каждый запрос
const MAX_CONTEXT_MESSAGES = 20;

function toChatMessages(messages, memory, calibrating, reconnecting, calibrationJustFinished) {
  const system = { role: 'system', content: buildSystemPrompt(memory, calibrating, reconnecting, calibrationJustFinished) };
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

// DATA_DIR указывает на смонтированный постоянный диск в проде (например,
// Railway volume) — без него любой редеплой платформы стирает базу
// пользователей и подписки. Локально по умолчанию пишем рядом со скриптом,
// как раньше
const DATA_DIR = process.env.DATA_DIR || __dirname;
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let usersData = {};
try {
  usersData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
} catch (e) {
  usersData = {};
}
function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2));
  } catch (e) {
    console.error('Failed to save users:', e);
  }
}
function updateUserActivity(tgId) {
  if (!usersData[tgId]) usersData[tgId] = { tgId };
  usersData[tgId].lastActivity = Date.now();
  saveUsers();
}

// юзернейм бота — нужен только для отдачи клиенту готовой реферальной
// ссылки (см. /api/sync). Грузится один раз при старте; пока не пришёл —
// referralLink в ответе просто отсутствует, клиент карточку не показывает
let botUsername = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
  getBotUsername(process.env.TELEGRAM_BOT_TOKEN).then((u) => {
    botUsername = u;
  });
}

// +1 день подписки рефереру за каждого РЕАЛЬНОГО нового пользователя,
// который впервые открыл Mini App по его ссылке — не просто нажал /start
// в боте (это слишком легко наспамить), а прошёл проверку initData хотя бы
// один раз. reфCredited гарантирует, что один и тот же приглашённый может
// принести бонус только один раз, даже если он переходил по ссылке заново
const REFERRAL_BONUS_DAYS = 1;
function creditReferralIfAny(newTgId) {
  const user = usersData[newTgId];
  if (!user || !user.referredBy || user.referralCredited) return;
  const referrerId = user.referredBy;
  if (referrerId === newTgId) return; // на всякий случай, хотя onReferralStart уже режет самопригласы

  // реферер должен быть РЕАЛЬНЫМ пользователем, который сам хотя бы раз
  // открыл Mini App — без этой проверки в ссылку можно подставить любой
  // произвольный числовой id (?start=ref_999999999) и бесплатно начислить
  // ему (а по факту — заново созданной пустой записи) дни подписки
  const referrer = usersData[referrerId];
  if (!referrer || !referrer.appOpened) return;
  const bonusMs = REFERRAL_BONUS_DAYS * 24 * 60 * 60 * 1000;
  if (!referrer.subscriptionExpiresAt || referrer.subscriptionExpiresAt < Date.now()) {
    referrer.subscriptionExpiresAt = Date.now() + bonusMs;
  } else {
    referrer.subscriptionExpiresAt += bonusMs;
  }
  referrer.referralCount = (referrer.referralCount || 0) + 1;
  user.referralCredited = true;
  saveUsers();
  logEvent('referral_credited', referrerId, { newTgId, bonusDays: REFERRAL_BONUS_DAYS });

  sendMessage(
    process.env.TELEGRAM_BOT_TOKEN,
    referrerId,
    `по твоей ссылке зашёл друг — держи +${REFERRAL_BONUS_DAYS} день подписки бро 🤝`,
    'Открыть чат',
    process.env.FRONTEND_ORIGIN,
  ).catch((e) => console.error('Referral notify error:', e));
}

// вызывается из telegram.js при /start ref_<id> — привязывает нового
// человека к рефереру ДО того, как он вообще открыл Mini App. Кредит
// начисляется позже, в /api/sync, когда initData реально подтвердит,
// что это живой пользователь, а не просто нажатие кнопки в боте
function onReferralStart(newTgId, referrerId) {
  if (!referrerId || newTgId === referrerId) return;
  if (!usersData[newTgId]) usersData[newTgId] = { tgId: newTgId };
  const user = usersData[newTgId];
  if (user.appOpened || user.referredBy) return; // уже реальный пользователь или уже привязан
  user.referredBy = referrerId;
  saveUsers();
}

// вызывается из telegram.js при /start src_<канал> — атрибуция первого
// касания для маркетинговых ссылок (t.me/<бот>?start=src_reddit и т.п.),
// чтобы в /admin/stats было видно, какая площадка реально приводит людей,
// а не только сколько раз где-то был опубликован пост. Источник фиксируется
// один раз при первом переходе и не перезаписывается повторными /start
function onSourceStart(newTgId, source) {
  if (!usersData[newTgId]) usersData[newTgId] = { tgId: newTgId };
  const user = usersData[newTgId];
  if (user.source) return;
  user.source = source;
  saveUsers();
}

// минимальный лог воронки (регистрация → калибровка → пейволл → оплата) в
// отдельный JSONL-файл, чтобы понимать, где отваливаются люди, не поднимая
// полноценную аналитику. Не должен уметь ронять основной запрос, поэтому
// ошибки записи молча проглатываются
const EVENTS_FILE = path.join(DATA_DIR, 'events.log');
function logEvent(event, tgId, extra) {
  try {
    const line = JSON.stringify({ ts: Date.now(), event, tgId: tgId || null, ...extra }) + '\n';
    fs.appendFileSync(EVENTS_FILE, line);
  } catch (e) {
    // логирование не должно ломать основной поток
  }
}

// извлекает доверенный tgId из initData запроса — НЕ из сырого поля tgId,
// присланного клиентом напрямую (initDataUnsafe.user.id не подписан, любой
// может подставить чужой id). Возвращает null, если подписи нет/невалидна —
// в этом случае вызывающий код просто не делает Telegram-специфичных вещей,
// как будто клиент открыт в обычном браузере вне Telegram
function trustedTgId(req) {
  const user = validateInitData(req.body?.initData, process.env.TELEGRAM_BOT_TOKEN);
  return user ? String(user.id) : null;
}

// бесплатный лимит и подписка: единая точка расчёта, чтобы /api/sync,
// /api/pending и пейволл-гейт в /api/chat никогда не расходились в логике.
// Лимит ДНЕВНОЙ: 15 бесплатных сообщений в сутки, счётчик обнуляется в
// полночь по Москве (аудитория российская; UTC+3, переходов на летнее
// время в РФ нет — смещение можно считать константой)
const FREE_DAILY_LIMIT = 15;

function currentDayKey() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// наступил новый день — счётчик начинается заново
function ensureDailyCounter(user) {
  const today = currentDayKey();
  if (user.dailyCountDay !== today) {
    user.dailyCountDay = today;
    user.dailyMessageCount = 0;
  }
  if (typeof user.dailyMessageCount !== 'number') user.dailyMessageCount = 0;
}

function hasActiveSub(user) {
  return Boolean(user && user.subscriptionExpiresAt && user.subscriptionExpiresAt > Date.now());
}

function userNeedsPayment(tgId) {
  const user = usersData[tgId];
  if (!user) return false;
  if (hasActiveSub(user)) return false;
  ensureDailyCounter(user);
  return user.dailyMessageCount >= FREE_DAILY_LIMIT;
}

// сколько бесплатных сообщений осталось сегодня; null = безлимит (подписка)
function freeRemaining(tgId) {
  const user = usersData[tgId];
  if (!user) return FREE_DAILY_LIMIT;
  if (hasActiveSub(user)) return null;
  ensureDailyCounter(user);
  return Math.max(0, FREE_DAILY_LIMIT - user.dailyMessageCount);
}

// статус для клиента (настройки, пейволл, подсказка об остатке).
// founderSlotsRemaining объявлена ниже по файлу (FOUNDER_SLOTS/foundersCount),
// но это безопасно — обе читаются только при вызове billingStatus(), то есть
// уже после того, как модуль полностью загрузился
function billingStatus(tgId) {
  const user = usersData[tgId];
  return {
    needsPayment: userNeedsPayment(tgId),
    freeRemaining: freeRemaining(tgId),
    subscriptionExpiresAt: hasActiveSub(user) ? user.subscriptionExpiresAt : null,
    founderSlotsRemaining: Math.max(0, FOUNDER_SLOTS - foundersCount()),
  };
}

app.post('/api/sync', (req, res) => {
  const tgId = trustedTgId(req);
  if (!tgId) return res.json({ ok: false });
  const { memoryFacts, remindersEnabled } = req.body || {};
  if (!usersData[tgId]) usersData[tgId] = { tgId };
  const user = usersData[tgId];

  // appOpened, а не "запись в usersData существует" — запись могла появиться
  // раньше через onReferralStart (человек нажал /start у реферера), но это
  // не значит, что он реально дошёл до Mini App. Только здесь, после
  // проверки initData, засчитываем регистрацию и реферальный бонус
  if (!user.appOpened) {
    user.appOpened = true;
    logEvent('user_registered', tgId);
    creditReferralIfAny(tgId);
  }

  if (memoryFacts !== undefined) user.memoryFacts = memoryFacts;
  if (remindersEnabled !== undefined) user.remindersEnabled = remindersEnabled;
  user.lastActivity = Date.now();
  saveUsers();

  const referralLink = botUsername ? `https://t.me/${botUsername}?start=ref_${tgId}` : null;
  res.json({
    ok: true,
    ...billingStatus(tgId),
    referralLink,
    referralCount: user.referralCount || 0,
  });
});

app.post('/api/pending', (req, res) => {
  const tgId = trustedTgId(req);
  if (!tgId || !usersData[tgId]) return res.json({ messages: [] });
  const messages = usersData[tgId].pendingMessages || [];
  usersData[tgId].pendingMessages = [];
  if (messages.length > 0) saveUsers();
  // клиент решает по этим полям, показывать ли пейволл сразу при открытии
  // и подсказку об остатке бесплатных сообщений
  res.json({ messages, ...billingStatus(tgId) });
});

// POST /api/chat — стримит ответ бро через SSE в собственном простом формате
// ({text}/{done}/{error}), внутри дергая DeepSeek; ключ остаётся только на сервере
app.post('/api/chat', chatRateLimit, async (req, res) => {
  const { messages, memory, calibrating, reconnecting, calibrationJustFinished } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages обязателен' });
    return;
  }

  const tgId = trustedTgId(req);
  if (tgId) updateUserActivity(tgId);

  const sseHeaders = () => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
  };
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  // детерминированный кризисный фильтр — СТРОГО раньше пейволла и счётчика:
  // кризисный ответ детерминированный и бесплатный (модель не вызывается),
  // человек в кризисе никогда не должен упереться в счёт вместо горячей линии
  const lastUserMessage = [...messages].reverse().find((m) => m && m.role === 'user' && typeof m.content === 'string');
  if (lastUserMessage && detectCrisis(lastUserMessage.content)) {
    console.log(`crisis_filter_triggered: true (len=${lastUserMessage.content.length})`);
    logEvent('crisis_filter_triggered', tgId, { len: lastUserMessage.content.length });
    sseHeaders();
    send({ text: getCrisisResponse() });
    send({ done: true });
    res.end();
    return;
  }

  if (tgId) {
    if (userNeedsPayment(tgId)) {
      logEvent('paywall_shown', tgId);
      res.status(402).json({ needsPayment: true, freeRemaining: 0 });
      return;
    }
    if (!hasActiveSub(usersData[tgId])) {
      ensureDailyCounter(usersData[tgId]);
      usersData[tgId].dailyMessageCount += 1;
      saveUsers();
    }
    if (calibrationJustFinished) logEvent('calibration_finished', tgId);
  }

  // если апстрим упал и человек не получил ответа — возвращаем списанное
  // сообщение обратно, дневной лимит не должен сгорать на наших ошибках
  const refundMessage = () => {
    const user = tgId && usersData[tgId];
    if (!user || hasActiveSub(user)) return;
    user.dailyMessageCount = Math.max(0, (user.dailyMessageCount || 0) - 1);
    saveUsers();
  };

  sseHeaders();

  // первым SSE-событием сообщаем остаток бесплатных сообщений на сегодня —
  // клиент показывает мягкую подсказку, когда лимит подходит к концу.
  // Подписчикам не шлём (null = безлимит, подсказка не нужна)
  if (tgId) {
    const remaining = freeRemaining(tgId);
    if (typeof remaining === 'number') send({ meta: { freeRemaining: remaining } });
  }

  try {
    const upstream = await deepseekFetch('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: toChatMessages(messages, memory, Boolean(calibrating), Boolean(reconnecting), Boolean(calibrationJustFinished)),
        stream: true,
        // CHAT_MODEL — reasoning-модель: часть токенов уходит на скрытые
        // рассуждения (reasoning_content), 512 не хватало на развёрнутый
        // видимый ответ (обрезался на finish_reason: "length")
        max_tokens: 1500,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => upstream.statusText);
      refundMessage();
      send({ error: errText });
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    for await (const chunk of upstream.body) {
      const str = decoder.decode(chunk, { stream: true });
      buffer += str;
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const block of events) {
        const line = block.split('\n').find((l) => l.startsWith('data:'));
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
          fullText += delta;
          send({ text: delta });
        }
        if (choice?.finish_reason) {
          send({ done: true });
        }
      }
    }

    // сюда попадают ТОЛЬКО reconnect-сообщения, которые клиент сам запросил при
    // открытии уже загруженного чата (см. checkPendingAndReconnect в Chat.tsx) —
    // человек в этот момент смотрит в приложение и получает текст через SSE,
    // поэтому Telegram-пуш с тем же текстом был бы дублирующим уведомлением.
    // Настоящие проактивные пуши "человек ушёл и не возвращается" шлёт отдельно
    // pushReconnectIfDue ниже — там sendMessage уместен, здесь нет.

    res.end();
  } catch (err) {
    refundMessage();
    send({ error: String(err && err.message ? err.message : err) });
    res.end();
  }
});

// POST /api/memory/extract — лёгкий вызов на самой дешёвой модели, извлекает
// 0-2 факта о юзере из последнего обмена. Если передан currentTopic (во время
// калибровки) — дополнительно определяет, закрыта ли именно эта тема сейчас
app.post('/api/memory/extract', chatRateLimit, async (req, res) => {
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

// оффер для первых читателей: те же 150 Stars, но 90 дней вместо 30 —
// снимает главный барьер нулевого запуска ("зачем платить первым за
// непроверенный продукт"), пока не появилось ни одного реального отзыва.
// Флаг isFounder персистентный на юзере, так что счётчик не зависит от
// отдельного файла состояния и переживает рестарт сервера
const FOUNDER_SLOTS = 20;
function foundersCount() {
  return Object.values(usersData).filter((u) => u.isFounder).length;
}

app.post('/api/payment/invoice', chatRateLimit, async (req, res) => {
  const tgId = trustedTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const isFounderOffer = foundersCount() < FOUNDER_SLOTS;
    const title = isFounderOffer ? 'Бро для первых — 90 дней' : 'Безлимитный бро на месяц';
    const description = isFounderOffer
      ? 'Оффер для первых подписчиков: общение без ограничений на 90 дней вместо 30 — по той же цене.'
      : 'Общение без ограничений: доступ ко всем функциям бро на 30 дней.';
    const payload = isFounderOffer ? 'sub_1_month_founder' : 'sub_1_month';
    const currency = 'XTR'; // Telegram Stars
    const prices = [{ label: isFounderOffer ? '90 дней' : '1 месяц', amount: 150 }]; // 150 Звезд

    const invoiceUrl = await createInvoiceLink(token, title, description, payload, currency, prices);
    logEvent('invoice_created', tgId, { payload });
    res.json({ ok: true, invoiceUrl });
  } catch (err) {
    console.error('Invoice error:', err);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// собирает сводку по users.json + events.log — единственный способ узнать,
// сколько людей реально есть, без ручного grep по файлам на сервере
function computeStats() {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  // appOpened появился позже lastActivity — у пользователей, заведённых до
  // добавления реферальной системы, этого флага нет, хотя это реальные,
  // активные аккаунты. Считаем "реальным" пользователем любого из двух
  // признаков, иначе статистика тихо теряет самых первых юзеров
  const users = Object.values(usersData).filter((u) => u.appOpened || u.lastActivity);

  const totals = {
    totalUsers: users.length,
    active24h: users.filter((u) => u.lastActivity && now - u.lastActivity < DAY).length,
    active7d: users.filter((u) => u.lastActivity && now - u.lastActivity < 7 * DAY).length,
    activeSubs: users.filter((u) => hasActiveSub(u)).length,
    totalReferrals: users.reduce((sum, u) => sum + (u.referralCount || 0), 0),
  };

  // разбивка по источнику первого касания (src_reddit, src_vc, ...) —
  // "прямой" означает, что человек пришёл без маркетинговой ссылки
  // (открыл бота напрямую или по реферальной ссылке друга)
  const bySourceMap = {};
  for (const u of users) {
    const key = u.source || 'прямой/реферал';
    if (!bySourceMap[key]) bySourceMap[key] = { total: 0, subs: 0 };
    bySourceMap[key].total += 1;
    if (hasActiveSub(u)) bySourceMap[key].subs += 1;
  }
  const bySource = Object.entries(bySourceMap)
    .map(([source, v]) => ({ source, ...v }))
    .sort((a, b) => b.total - a.total);

  const funnelEvents = [
    'user_registered',
    'calibration_finished',
    'paywall_shown',
    'invoice_created',
    'payment_success',
  ];
  const eventCounts = {};
  let crisisCount = 0;
  try {
    const lines = fs.readFileSync(EVENTS_FILE, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        eventCounts[evt.event] = (eventCounts[evt.event] || 0) + 1;
        if (evt.event === 'crisis_filter_triggered') crisisCount += 1;
      } catch {
        // повреждённая строка лога — пропускаем, не роняем всю статистику
      }
    }
  } catch {
    // events.log ещё не создан — воронка просто пустая
  }

  const funnel = funnelEvents.map((event) => ({ event, count: eventCounts[event] || 0 }));

  return { totals, funnel, bySource, crisisCount, generatedAt: now };
}

// человекочитаемые подписи для сырых имён funnel-событий — воронка должна
// читаться сама по себе, без знания того, как называется event в коде
const FUNNEL_LABELS = {
  user_registered: 'зарегистрировались',
  calibration_finished: 'прошли знакомство',
  paywall_shown: 'увидели пейволл',
  invoice_created: 'начали оплату',
  payment_success: 'оплатили',
};

function renderStatsHtml(stats) {
  const { totals, funnel, bySource, crisisCount } = stats;
  const revenueStars = (funnel.find((f) => f.event === 'payment_success')?.count || 0) * 150;

  // ширина полосы = доля от первого (самого крупного) шага воронки; у
  // нулевых шагов оставляем видимый минимум в 3px, чтобы шаг не исчезал
  // визуально, а читался как "этап есть, но пусто"
  const funnelMax = funnel[0]?.count || 0;
  const funnelRows = funnel
    .map((f) => {
      const pct = funnelMax > 0 ? Math.round((f.count / funnelMax) * 100) : 0;
      const widthPct = funnelMax > 0 ? Math.max((f.count / funnelMax) * 100, f.count > 0 ? 4 : 0) : 0;
      return `<div class="bar-row">
        <div class="bar-row-head">
          <span class="bar-row-name">${FUNNEL_LABELS[f.event] || f.event}</span>
          <span class="bar-row-value">${f.count}<span class="bar-row-pct">${funnelMax > 0 ? ` · ${pct}%` : ''}</span></span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${widthPct}%"></div></div>
      </div>`;
    })
    .join('');

  const sourceMax = Math.max(1, ...bySource.map((s) => s.total));
  const sourceRows = bySource
    .map((s) => {
      const widthPct = Math.max((s.total / sourceMax) * 100, 4);
      return `<div class="bar-row">
        <div class="bar-row-head">
          <span class="bar-row-name">${s.source}</span>
          <span class="bar-row-value">${s.total} польз.<span class="bar-row-pct"> · ${s.subs} подп.</span></span>
        </div>
        <div class="bar-track"><div class="bar-fill bar-fill--source" style="width:${widthPct}%"></div></div>
      </div>`;
    })
    .join('');

  return `<!doctype html>
<html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>бро · статистика</title>
<style>
  :root {
    --bg: #F5F0E6; --text: #2D2A26; --card-bg: #FCFBF8; --label: #837C6C;
    --border: #E8E2D6; --shadow: rgba(0,0,0,0.06);
    --accent-bar: #436F94; --track-bg: #EAE3D4; --source-bar: #6A8CA7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #18181A; --text: #EDEAE2; --card-bg: #242426; --label: #A39C8C;
      --border: #333230; --shadow: rgba(0,0,0,0.35);
      --accent-bar: #6A9BC7; --track-bg: #302F2E; --source-bar: #4F7EA3;
    }
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text); padding: 24px; max-width: 640px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 14px; font-weight: 600; color: var(--label); text-transform: uppercase; letter-spacing: 0.03em; margin: 32px 0 12px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 20px 0; }
  .card { background: var(--card-bg); border-radius: 14px; padding: 16px 18px; box-shadow: 0 1px 3px var(--shadow); }
  .card .num { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .card .label { font-size: 12px; color: var(--label); margin-top: 3px; }
  .panel { background: var(--card-bg); border-radius: 14px; padding: 18px 20px 6px; box-shadow: 0 1px 3px var(--shadow); }
  .bar-row { margin-bottom: 16px; }
  .bar-row:last-child { margin-bottom: 4px; }
  .bar-row-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; gap: 12px; }
  .bar-row-name { font-size: 14px; }
  .bar-row-value { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .bar-row-pct { font-weight: 400; color: var(--label); }
  .bar-track { height: 10px; border-radius: 5px; background: var(--track-bg); overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 5px; background: var(--accent-bar); transition: width 0.2s; }
  .bar-fill--source { background: var(--source-bar); }
  .updated { font-size: 12px; color: var(--label); margin-top: 20px; }
</style></head>
<body>
  <h1>бро · статистика</h1>
  <div class="cards">
    <div class="card"><div class="num">${totals.totalUsers}</div><div class="label">всего пользователей</div></div>
    <div class="card"><div class="num">${totals.active24h}</div><div class="label">активны за 24ч</div></div>
    <div class="card"><div class="num">${totals.active7d}</div><div class="label">активны за 7д</div></div>
    <div class="card"><div class="num">${totals.activeSubs}</div><div class="label">активных подписок</div></div>
    <div class="card"><div class="num">${totals.totalReferrals}</div><div class="label">приглашено по рефералке</div></div>
    <div class="card"><div class="num">${revenueStars} ⭐</div><div class="label">заработано (Stars)</div></div>
  </div>

  <h2>воронка</h2>
  <div class="panel">${funnelRows}</div>

  ${bySource.length > 0 ? `<h2>по источнику</h2>
  <div class="panel">${sourceRows}</div>` : ''}

  ${crisisCount > 0 ? `<p style="color:#9a4b3f; font-size:13px; margin-top:16px;">кризисный фильтр сработал ${crisisCount} раз(а) — стоит проверить, что реагирование работает как надо</p>` : ''}
  <p class="updated">обновлено: ${new Date(stats.generatedAt).toLocaleString('ru-RU')}</p>
</body></html>`;
}

app.get('/admin/stats', (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key || req.query.key !== key) {
    return res.status(404).send('Not found');
  }
  res.send(renderStatsHtml(computeStats()));
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
function onPaymentSuccessful(tgId, durationDays, payload) {
  if (!usersData[tgId]) usersData[tgId] = { tgId };
  const user = usersData[tgId];
  const durationMs = durationDays * 24 * 60 * 60 * 1000;
  if (!user.subscriptionExpiresAt || user.subscriptionExpiresAt < Date.now()) {
    user.subscriptionExpiresAt = Date.now() + durationMs;
  } else {
    user.subscriptionExpiresAt += durationMs;
  }
  // помечаем "основателем" тех, кто попал в оффер FOUNDER_SLOTS — флаг
  // персистентный и не снимается, даже если слоты потом закончатся у
  // следующих; earlyAdopterCount() считает именно этот флаг
  if (payload === 'sub_1_month_founder') user.isFounder = true;
  saveUsers();
  logEvent('payment_success', tgId, { durationDays, payload });
  console.log(`User ${tgId} bought subscription. Expires: ${new Date(user.subscriptionExpiresAt)}`);
}

startPolling(process.env.TELEGRAM_BOT_TOKEN, process.env.FRONTEND_ORIGIN, { onPaymentSuccessful, onReferralStart, onSourceStart });

// фоновая задача для проактивных пушей (раз в час). Пуши для разных
// пользователей независимы друг от друга — гоним их параллельно
// (Promise.allSettled), а не по одному, иначе с ростом базы пользователей
// один медленный/зависший DeepSeek-запрос откладывал бы push всем следующим
async function pushReconnectIfDue(tgId, now) {
  const user = usersData[tgId];
  if (!user.remindersEnabled || !user.lastActivity) return;
  if (now - user.lastActivity <= 3 * 60 * 60 * 1000) return;
  // уже писали с момента этого исчезновения - ждём, пока человек сам
  // вернётся (тогда lastActivity снова обгонит lastPush), а не долбим
  // напоминанием каждые 24ч, пока он молчит
  if (user.lastPush && user.lastPush >= user.lastActivity) return;

  try {
    const sysPrompt = buildSystemPrompt(user.memoryFacts, false, true, false);
    const upstream = await deepseekFetch('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: 'Начни диалог первым.' }
        ],
        max_tokens: 1500,
      }),
    });
    if (!upstream.ok) return;

    const data = await upstream.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return;

    await sendMessage(process.env.TELEGRAM_BOT_TOKEN, tgId, text.trim(), 'Открыть чат', process.env.FRONTEND_ORIGIN);
    user.lastPush = now;
    user.pendingMessages = user.pendingMessages || [];
    user.pendingMessages.push({ role: 'assistant', content: text.trim() });
    saveUsers();
    logEvent('reconnect_push_sent', tgId);
  } catch (err) {
    console.error('Push error for', tgId, err);
  }
}

setInterval(() => {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.FRONTEND_ORIGIN) return;
  const now = Date.now();
  void Promise.allSettled(Object.keys(usersData).map((tgId) => pushReconnectIfDue(tgId, now)));
}, 60 * 60 * 1000); // каждый час
