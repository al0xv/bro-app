// Тонкий клиент к DeepSeek API (OpenAI-совместимый формат chat/completions).
// Обычный fetch на стандартном доверенном хранилище сертификатов — никакого
// кастомного TLS не требуется (в отличие от прежней GigaChat-интеграции).

async function deepseekFetch(path, options = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseUrl = process.env.DEEPSEEK_API_BASE_URL;

  if (!apiKey) throw new Error('DEEPSEEK_API_KEY не настроен на сервере');
  if (!baseUrl) throw new Error('DEEPSEEK_API_BASE_URL не настроен на сервере');

  return fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
      Authorization: `Bearer ${apiKey}`,
    },
  });
}

module.exports = { deepseekFetch };
