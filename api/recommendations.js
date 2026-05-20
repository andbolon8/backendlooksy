// Vercel Serverless Function — генерация рекомендаций через Claude API.
//
// Эндпоинт: POST /api/recommendations
// Тело запроса: { score, percentile, symmetry, goldenRatio, thirdsProportion, faceShape, description }
// Ответ: { sections: [{ title, items: [string] }] }
//
// Развёртывание см. в backend/README.md

const ALLOWED_SHAPES = ['OVAL', 'ROUND', 'SQUARE', 'HEART', 'OBLONG', 'DIAMOND'];

// --- Простой in-memory rate limiter ---
// Хранит, сколько запросов с каждого IP за последнюю минуту.
// ВАЖНО: на Vercel это работает в пределах одного "тёплого" инстанса. При высоких
// нагрузках инстансов несколько, и лимит не идеально точный, но для базовой защиты
// от случайного спама достаточно. Для жёсткого лимита нужен Upstash Redis (см. README).
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 минута
const RATE_LIMIT_MAX = 8;               // не более 8 запросов в минуту с одного IP

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (record.count >= RATE_LIMIT_MAX) {
    return false;
  }
  record.count += 1;
  return true;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Secret');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- Проверка секрета приложения ---
  // Приложение шлёт заголовок X-App-Secret. Если он не совпадает с тем, что в env,
  // запрос отклоняется. Это отсекает простые curl-запросы от чужих.
  // (Секрет всё же можно вытащить из APK, но это уже фильтр от случайных людей.)
  const expectedSecret = process.env.APP_SECRET;
  if (expectedSecret) {
    const got = req.headers['x-app-secret'];
    if (got !== expectedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // --- Rate limit по IP ---
  const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // --- Валидация входных данных ---
  const { score, percentile, symmetry, goldenRatio, thirdsProportion, faceShape, description } = req.body || {};
  if (typeof score !== 'number' || !ALLOWED_SHAPES.includes(faceShape)) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const shapeMap = {
    OVAL: 'овальная', ROUND: 'круглая', SQUARE: 'квадратная',
    HEART: 'сердце', OBLONG: 'удлинённая', DIAMOND: 'ромбовидная'
  };

  // System-промпт задаёт роль и формат — модель следует ему строже, чем инструкциям
  // внутри user-сообщения.
  const systemPrompt = `Ты — профессиональный стилист и косметолог, ассистент приложения для геометрического анализа лица.
Твоя задача — давать персональные рекомендации по улучшению внешности на основе геометрических метрик.

ПРАВИЛА:
- Тон позитивный и поддерживающий, как у опытного стилиста.
- НИКОГДА не пиши про "недостатки", "проблемы" или "плохие черты". Только усиление сильных сторон и тактичная, мягкая коррекция.
- Советы конкретные и практичные, без общих фраз и без воды.
- Пиши на русском языке.
- Возвращай ТОЛЬКО валидный JSON без markdown-обёрток, без пояснений до или после.`;

  const userPrompt = `Данные пользователя:
- Общая оценка: ${score}/10 (лучше, чем у ${percentile}% людей)
- Симметрия лица: ${symmetry}%
- Близость к золотому сечению: ${goldenRatio}%
- Правило третей: ${thirdsProportion}%
- Форма лица: ${shapeMap[faceShape]}
- Авто-описание: "${description}"

Сгенерируй ровно 4 раздела с 3-5 конкретными советами в каждом.

Разделы строго в таком порядке:
1. "Причёска" — стрижка/укладка под форму лица
2. "Уход и кожа" — базовый skincare-роутина
3. "Стиль и фото" — ракурс, освещение, цвет одежды для фото
4. "Брови и черты" — груминг, мелкие коррекции

Формат ответа (строго JSON):
{
  "sections": [
    { "title": "Причёска", "items": ["совет 1", "совет 2", "совет 3"] },
    { "title": "Уход и кожа", "items": ["...", "..."] },
    { "title": "Стиль и фото", "items": ["...", "..."] },
    { "title": "Брови и черты", "items": ["...", "..."] }
  ]
}`;

  // Таймаут на запрос к Claude — чтобы функция не висела вечно при сетевых проблемах.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    clearTimeout(timeout);

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('Claude API error:', errText);
      return res.status(502).json({ error: 'AI service error' });
    }

    const data = await claudeRes.json();
    const text = data.content?.[0]?.text || '';

    let parsed;
    try {
      const clean = text.replace(/```json\s*|\s*```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error('Failed to parse Claude response:', text);
      return res.status(502).json({ error: 'Bad AI response format' });
    }

    if (!parsed.sections || !Array.isArray(parsed.sections)) {
      return res.status(502).json({ error: 'Bad AI response structure' });
    }

    return res.status(200).json(parsed);
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') {
      console.error('Claude request timed out');
      return res.status(504).json({ error: 'AI service timeout' });
    }
    console.error('Handler error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
