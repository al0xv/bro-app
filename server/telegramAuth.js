// Проверка Telegram Mini App initData по официальной схеме
// (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
//
// Клиент (Telegram WebApp JS SDK) даёт ДВА поля:
//   - initDataUnsafe — уже распарсенный объект, но Telegram сам называет его
//     "unsafe": он ничем не подписан и любой может подделать его на клиенте.
//   - initData — сырая строка с полем hash, подписанным HMAC-SHA256 на основе
//     токена бота. Только её стоит доверять, и только после проверки подписи
//     здесь, на сервере.
//
// Раньше сервер брал tgId напрямую из тела запроса клиента — это позволяло
// подставить любой чужой tgId и переписать чужую память/устроить спам через
// бота. Теперь сервер доверяет только id, извлечённому из провалидированной
// initData.

const crypto = require('crypto');

const MAX_AGE_SECONDS = 24 * 60 * 60; // как рекомендует Telegram — данные не старше суток

function validateInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string' || !botToken) return null;

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (!timingSafeEqualHex(computedHash, hash)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return null;
  const ageSeconds = Date.now() / 1000 - authDate;
  if (ageSeconds > MAX_AGE_SECONDS || ageSeconds < -60) return null; // просрочено или из будущего (скос часов)

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    user = null;
  }
  if (!user || typeof user.id !== 'number') return null;

  return { id: user.id, firstName: user.first_name, username: user.username };
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

module.exports = { validateInitData };
