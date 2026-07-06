// Telegram-бот на long polling. Живёт в ОТДЕЛЬНОМ приложении, вне
// московского региона, потому что бэкенд в Москве физически не может
// достучаться до api.telegram.org (см. логи: "fetch failed" на каждый
// тик поллинга) — похоже на сетевую блокировку на уровне провайдера/региона.
// У этого сервиса нет доступа к DeepSeek и памяти — только пересылка
// приветствия с кнопкой запуска Mini App.

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

async function clearWebhook(token) {
  try {
    await fetch(TELEGRAM_API + '/bot' + token + '/deleteWebhook');
  } catch {
    // best effort
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

    setTimeout(tick, failCount > 0 ? Math.min(failCount * 2000, 15000) : 0);
  }

  clearWebhook(token).then(() => {
    console.log('telegram polling: запущен');
    tick();
  });
}

module.exports = { startPolling };
