// Telegram-бот на long polling (а не вебхуке): сервер сам периодически
// спрашивает у Telegram новые апдейты, а не ждёт, пока Telegram достучится
// до нас. Это надёжнее вебхука на этом хостинге — не зависит от того,
// может ли инфраструктура Telegram установить входящее соединение к нам,
// а только от того, можем ли МЫ дозвониться до api.telegram.org (это уже
// проверено и работает).
//
// Токен бота остаётся только на сервере, в переменной окружения
// TELEGRAM_BOT_TOKEN. Ссылка на Mini App берётся из FRONTEND_ORIGIN — той
// же переменной, что уже используется для CORS.

const TELEGRAM_API = 'https://api.telegram.org';

const WELCOME_TEXT =
  'Привет! Я бро — твой ИИ-друг. Я не как обычный чат-бот: я помню, что у тебя происходит, и говорю с тобой как друг, а не как ассистент. Не терапевт — просто тот, кто выслушает и поддержит.\n\nЖми кнопку ниже, чтобы начать.';

function sendWelcome(token, appUrl, chatId) {
  return sendMessage(token, chatId, WELCOME_TEXT, 'Открыть бро', appUrl);
}

async function sendMessage(token, chatId, text, buttonText, appUrl) {
  const body = {
    chat_id: chatId,
    text: text,
  };
  if (buttonText && appUrl) {
    body.reply_markup = {
      inline_keyboard: [[{ text: buttonText, web_app: { url: appUrl } }]],
    };
  }
  try {
    const res = await fetch(TELEGRAM_API + '/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 429) {
        console.warn('Telegram API rate limit (429 Too Many Requests) for chat', chatId);
      } else {
        const errText = await res.text().catch(() => res.statusText);
        console.error(`Telegram API error ${res.status} for chat ${chatId}: ${errText}`);
      }
    }
    return res;
  } catch (err) {
    console.error('Network error sending message to Telegram:', err);
    throw err;
  }
}

// на всякий случай явно снимаем вебхук перед стартом поллинга — Telegram
// не даёт использовать getUpdates, пока активен webhook (ошибка 409)
async function clearWebhook(token) {
  try {
    await fetch(TELEGRAM_API + '/bot' + token + '/deleteWebhook');
  } catch {
    // best effort — если не получилось снять, следующий тик всё равно
    // получит явную 409-ошибку от Telegram и залогирует её
  }
}

function startPolling(token, appUrl, handlers = {}) {
  if (!token || !appUrl) {
    console.log('telegram polling: отключён (нет TELEGRAM_BOT_TOKEN или FRONTEND_ORIGIN)');
    return;
  }

  let offset = 0;
  let failCount = 0;

  async function tick() {
    try {
      const res = await fetch(
        TELEGRAM_API + '/bot' + token + '/getUpdates?timeout=25&offset=' + offset + '&allowed_updates=["message","pre_checkout_query"]',
      );
      const data = await res.json();

      if (data.ok && Array.isArray(data.result)) {
        failCount = 0;
        for (const update of data.result) {
          offset = update.update_id + 1;
          
          if (update.pre_checkout_query) {
            // Подтверждаем доступность товара
            await fetch(TELEGRAM_API + '/bot' + token + '/answerPreCheckoutQuery', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                pre_checkout_query_id: update.pre_checkout_query.id,
                ok: true,
              }),
            });
            continue;
          }

          const message = update.message;
          if (message && message.successful_payment) {
            // Платеж прошел успешно
            if (handlers.onPaymentSuccessful) {
              const payload = message.successful_payment.invoice_payload;
              // на будущее — сюда добавляются другие тарифы по payload.
              // sub_1_month_founder — оффер для первых N подписчиков (см.
              // FOUNDER_SLOTS в index.js): та же цена, втрое больше дней
              const DURATIONS = { sub_1_month: 30, sub_1_month_founder: 90 };
              handlers.onPaymentSuccessful(String(message.chat.id), DURATIONS[payload] ?? 30, payload);
            }
            // Можно также отправить сообщение с благодарностью
            await sendMessage(token, message.chat.id, 'Оплата прошла успешно! Спасибо за поддержку. Теперь мы можем общаться безлимитно! ⚡️', 'Открыть бро', appUrl).catch(console.error);
            continue;
          }

          const text = message && typeof message.text === 'string' ? message.text.trim() : '';
          const lowerText = text.toLowerCase();
          if (message && message.chat && (lowerText.startsWith('/start') || lowerText === 'start')) {
            // реферальная ссылка приходит как payload после /start —
            // t.me/<бот>?start=ref_<tgId> Telegram передаёт сюда как
            // "/start ref_123456". Парсим ДО отправки приветствия, чтобы
            // сервер успел привязать реферера прежде, чем человек откроет
            // Mini App и сработает /api/sync
            const payload = text.split(/\s+/)[1];
            const refMatch = payload && payload.match(/^ref_(\d+)$/);
            if (refMatch && handlers.onReferralStart) {
              handlers.onReferralStart(String(message.chat.id), refMatch[1]);
            }
            // маркетинговые ссылки вида t.me/<бот>?start=src_reddit — так
            // видно, какая площадка реально приводит людей, а не только
            // сколько раз где-то был опубликован пост
            const srcMatch = payload && payload.match(/^src_([a-z0-9_]+)$/i);
            if (srcMatch && handlers.onSourceStart) {
              handlers.onSourceStart(String(message.chat.id), srcMatch[1].toLowerCase());
            }
            void sendWelcome(token, appUrl, message.chat.id).catch((e) => {
              console.error('Failed to send welcome message:', e);
            });
          }
        }
      } else if (!data.ok) {
        failCount += 1;
        console.log('telegram polling: ошибка getUpdates', data.description || data);
      }
    } catch (err) {
      failCount += 1;
      console.log('telegram polling: сетевой сбой', err && err.message ? err.message : err);
    }

    // если что-то пошло не так — небольшая пауза перед повтором, чтобы не
    // забивать логи мгновенным циклом ошибок; в норме следующий тик стартует
    // сразу же (getUpdates сам блокируется до 25с внутри long-poll)
    setTimeout(tick, failCount > 0 ? Math.min(failCount * 2000, 15000) : 0);
  }

  clearWebhook(token).then(() => {
    console.log('telegram polling: запущен');
    tick();
  });
}

// юзернейм бота нужен для построения персональных реферальных ссылок
// (t.me/<юзернейм>?start=ref_<tgId>) — сам бот его не хранит нигде, кроме
// как в своих же настройках на стороне Telegram
async function getBotUsername(token) {
  try {
    const res = await fetch(TELEGRAM_API + '/bot' + token + '/getMe');
    const data = await res.json();
    return data.ok ? data.result.username : null;
  } catch {
    return null;
  }
}

async function createInvoiceLink(token, title, description, payload, currency, prices) {
  const body = {
    title,
    description,
    payload,
    currency,
    prices,
  };
  const res = await fetch(TELEGRAM_API + '/bot' + token + '/createInvoiceLink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Failed to create invoice link');
  return data.result;
}

module.exports = { startPolling, sendWelcome, sendMessage, createInvoiceLink, getBotUsername };
