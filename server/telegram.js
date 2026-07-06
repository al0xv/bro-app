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
  'Привет! Я бро — твой ИИ-друг. Я не как обычный чат-бот: я помню, что у тебя происходит, и говорю с тобой как друг, а не как ассистент. Не пара, не терапевт — просто тот, кто выслушает и поддержит.\n\nЖми кнопку ниже, чтобы начать.';

function sendWelcome(token, appUrl, chatId) {
  return fetch(TELEGRAM_API + '/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: WELCOME_TEXT,
      reply_markup: {
        inline_keyboard: [[{ text: 'Открыть бро', web_app: { url: appUrl } }]],
      },
    }),
  });
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

function startPolling(token, appUrl) {
  if (!token || !appUrl) {
    console.log('telegram polling: отключён (нет TELEGRAM_BOT_TOKEN или FRONTEND_ORIGIN)');
    return;
  }

  let offset = 0;
  let failCount = 0;

  async function tick() {
    try {
      const res = await fetch(
        TELEGRAM_API + '/bot' + token + '/getUpdates?timeout=25&offset=' + offset,
      );
      const data = await res.json();

      if (data.ok && Array.isArray(data.result)) {
        failCount = 0;
        for (const update of data.result) {
          offset = update.update_id + 1;
          const message = update.message;
          const text = message && typeof message.text === 'string' ? message.text.trim() : '';
          if (message && message.chat && text.indexOf('/start') === 0) {
            void sendWelcome(token, appUrl, message.chat.id).catch(() => {});
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

module.exports = { startPolling };
