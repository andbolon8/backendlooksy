// /api/image-edit.js
// Принимает фото пользователя + текстовый промпт, генерирует
// отредактированную версию через Replicate FLUX Kontext Pro.
// Используется для подбора причёски и AI-улучшения ("Ты на 9.5").

// In-memory rate limit (как в recommendations.js).
const rateLimit = new Map(); // ip -> [timestamps]

function checkRateLimit(ip) {
  const now = Date.now();
  const window = 60_000; // 1 минута
  const maxPerMinute = 4; // не больше 4 генераций в минуту с одного IP

  const arr = (rateLimit.get(ip) || []).filter(t => now - t < window);
  if (arr.length >= maxPerMinute) return false;
  arr.push(now);
  rateLimit.set(ip, arr);
  return true;
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '8mb',  // фото в base64 могут быть тяжёлыми
    },
  },
  maxDuration: 60,        // FLUX Kontext генерирует ~10-30 сек, даём запас
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Проверка секрета приложения
  const appSecret = req.headers['x-app-secret'];
  if (!appSecret || appSecret !== process.env.APP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Rate limit
  const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Слишком много запросов. Подожди минуту.' });
  }

  const apiKey = process.env.REPLICATE_API_TOKEN;
  if (!apiKey) {
    console.error('REPLICATE_API_TOKEN not set');
    return res.status(500).json({ error: 'Image service not configured' });
  }

  const { imageBase64, prompt, mode } = req.body || {};

  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'imageBase64 required' });
  }
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt required' });
  }
  if (prompt.length > 1500) {
    return res.status(400).json({ error: 'prompt too long' });
  }
  // mode: "hairstyle" | "improve" — для логов и возможных будущих веток
  const safeMode = (mode === 'hairstyle' || mode === 'improve') ? mode : 'hairstyle';

  // Подготовка data URI для Replicate (модель принимает либо URL, либо data URI)
  const dataUri = imageBase64.startsWith('data:')
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;

  try {
    // Вызов FLUX Kontext Pro через "predictions with wait" — синхронный режим.
    // Это позволяет не опрашивать статус, Replicate сам подождёт и вернёт результат.
    const replicateRes = await fetch(
      'https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          // Prefer: wait — синхронный ответ, без поллинга
          'Prefer': 'wait=55',
        },
        body: JSON.stringify({
          input: {
            prompt: prompt,
            input_image: dataUri,
            output_format: 'jpg',
            safety_tolerance: 2,  // 0 (строго) .. 6 (мягко). 2 — баланс
          },
        }),
      }
    );

    if (!replicateRes.ok) {
      const errText = await replicateRes.text();
      console.error(`Replicate error ${replicateRes.status}:`, errText);
      // Маппим понятные ошибки
      if (replicateRes.status === 401) {
        return res.status(500).json({ error: 'Image service auth failed' });
      }
      if (replicateRes.status === 402) {
        return res.status(402).json({ error: 'У сервиса генерации закончился баланс' });
      }
      return res.status(502).json({ error: 'Ошибка сервиса генерации' });
    }

    const data = await replicateRes.json();

    // data.output — URL результата (либо строка, либо массив строк в зависимости от модели)
    let outputUrl = null;
    if (typeof data.output === 'string') {
      outputUrl = data.output;
    } else if (Array.isArray(data.output) && data.output.length > 0) {
      outputUrl = data.output[0];
    }

    if (!outputUrl) {
      // Может быть что генерация ещё идёт (status === 'starting' / 'processing')
      // или модель отвергла из-за safety. Возвращаем подробности.
      if (data.status === 'failed') {
        const err = data.error || 'Генерация не удалась';
        console.error('Replicate failed:', err);
        return res.status(502).json({ error: String(err) });
      }
      console.error('No output URL, status:', data.status, 'data:', JSON.stringify(data).slice(0, 500));
      return res.status(504).json({ error: 'Сервис не успел сгенерировать изображение' });
    }

    // ВАЖНО: раньше мы возвращали URL приложению, чтобы оно скачивало картинку
    // напрямую с CDN Replicate. Но у российских юзеров это часто не работает —
    // провайдер/VPN обрывает соединение к иностранному CDN, юзер видит
    // "Скачивание прервалось" при том что картинка уже сгенерирована и оплачена.
    //
    // Теперь бэкенд сам скачивает картинку (Vercel находится вне России —
    // ему CDN доступен) и возвращает её как base64. Приложение больше
    // не ходит к CDN, только к нашему Vercel — а с ним связь стабильная.
    try {
      const imgRes = await fetch(outputUrl, {
        headers: { 'User-Agent': 'Looksy-Backend/1.0' },
      });
      if (!imgRes.ok) {
        console.error(`CDN fetch failed ${imgRes.status}: ${outputUrl}`);
        return res.status(502).json({
          error: 'Картинка сгенерирована, но не удалось её получить с CDN',
          url: outputUrl,  // на всякий случай для отладки
        });
      }
      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const base64 = buf.toString('base64');

      return res.status(200).json({
        imageBase64: base64,
        contentType,
        mode: safeMode,
        // url оставляем для обратной совместимости — старые клиенты
        // (до v3.18) продолжат работать по URL
        url: outputUrl,
      });
    } catch (fetchErr) {
      console.error('Fetch CDN failed:', fetchErr);
      // Fallback: возвращаем URL как раньше, пусть клиент попробует сам
      return res.status(200).json({
        url: outputUrl,
        mode: safeMode,
      });
    }
  } catch (e) {
    console.error('image-edit error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
