const express = require('express');
const { startPolling } = require('./telegram');

const app = express();

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'bro-bot' });
});

const PORT = process.env.PORT || 8788;
app.listen(PORT, () => {
  console.log(`bro-bot listening on http://localhost:${PORT}`);
});

startPolling(process.env.TELEGRAM_BOT_TOKEN, process.env.FRONTEND_ORIGIN);
