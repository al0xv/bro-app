// Простой вебхук-обработчик Telegram-бота: отвечает на /start приветствием
// с кнопкой запуска Mini App. Токен бота остаётся только на сервере, в
// переменной окружения TELEGRAM_BOT_TOKEN. Ссылка на Mini App берётся из
// FRONTEND_ORIGIN — той же переменной, что уже используется для CORS.

const TELEGRAM_API = 'https://api.telegram.org';

const WELCOME_TEXT =
  'Привет! Я бро — твой ИИ-друг. Я не как обычный чат-бот: я помню, что у тебя происходит, и говорю с тобой как друг, а не как ассистент. Не пара, не терапевт — просто тот, кто выслушает и поддержит.\n\nЖми кнопку ниже, чтобы начать.';

// Telegram требует быстрый ответ 200 на вебхук, иначе будет ретраить апдейт —
// поэтому отвечаем сразу, а саму отправку сообщения не ждём (best-effort)
function handleWebhook(req, res) {
  res.sendStatus(200);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const appUrl = process.env.FRONTEND_ORIGIN;
  const message = (req.body || {}).message;
  if (!token || !appUrl || !message || !message.chat) return;

  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (text.indexOf('/start') !== 0) return;

  fetch(TELEGRAM_API + '/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: message.chat.id,
      text: WELCOME_TEXT,
      reply_markup: {
        inline_keyboard: [[{ text: 'Открыть бро', web_app: { url: appUrl } }]],
      },
    }),
  }).catch(function () {});
}

module.exports = { handleWebhook };
