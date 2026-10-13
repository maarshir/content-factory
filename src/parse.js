// Разбор ответа нейросети: оценка релевантности и текст поста.
// Файл без зависимостей: функции можно вставить в узел Code n8n целиком.
'use strict';

// Признаки того, что модель отказалась или ответила не по делу.
const JUNK = [
  /как (языковая )?модель/i,
  /\bas an ai\b/i,
  /\bi('|’)?m sorry\b/i,
  /не могу (выполнить|помочь|ответить)/i,
  /\{\{\s*\w+\s*\}\}/, // неподставленный шаблон промпта
];

// Достаёт первый объект JSON из ответа: модели оборачивают его в ```json,
// добавляют пояснения до и после. Скобки внутри строк учитываются.
function extractJson(raw) {
  const s = String(raw ?? '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Ответ модели по промпту из prompts/: {"relevance": 0..10, "text": "..."}.
// Возвращает { ok, relevance, text, reason }. ok = false, если ответ не разобран,
// оценка вне шкалы, текст пустой, слишком короткий или длинный, похож на отказ,
// или оценка ниже порога options.minRelevance (по умолчанию 6).
function parseModelResponse(raw, options = {}) {
  const minRelevance = options.minRelevance ?? 6;
  const minLength = options.minLength ?? 40;
  const maxLength = options.maxLength ?? 3500;
  const fail = (reason, extra = {}) => ({ ok: false, relevance: null, text: '', reason, ...extra });

  const data = extractJson(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('ответ не JSON');

  const r = typeof data.relevance === 'string' ? Number(data.relevance.replace(',', '.')) : data.relevance;
  if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 10) return fail('оценка вне шкалы 0–10');
  const relevance = Math.round(r * 10) / 10;

  if (typeof data.text !== 'string') return fail('нет текста', { relevance });
  const text = data.text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (relevance < minRelevance) return fail('ниже порога релевантности', { relevance, text });
  if (!text) return fail('пустой текст', { relevance });
  if (text.length < minLength) return fail('слишком короткий текст', { relevance, text });
  if (text.length > maxLength) return fail('слишком длинный текст', { relevance, text });
  if (JUNK.some((re) => re.test(text))) return fail('похоже на отказ модели', { relevance, text });

  return { ok: true, relevance, text, reason: null };
}

// Рубрики канала: на обложке плашкой, в посте хэштегом.
const TAGS = ['модели', 'исследования', 'продукты', 'код', 'бизнес', 'железо', 'законы', 'события'];
const DEFAULT_TAG = 'события';
const DEFAULT_EMOJI = '🧠';

function clean(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

// Один эмодзи в начале строки или запасной: модели иногда пишут слово или несколько значков.
function pickEmoji(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*️?)/u);
  return m ? m[1] : DEFAULT_EMOJI;
}

function pickTag(raw) {
  const s = String(raw ?? '').toLowerCase().replace(/^#/, '').trim();
  return TAGS.includes(s) ? s : DEFAULT_TAG;
}

// Ответ модели по prompts/telegram.md: части поста по отдельности.
// {"relevance", "tag", "emoji", "title", "lead", "points": [...], "full"}.
// Возвращает { ok, relevance, card, text, reason }: card это части поста,
// text это суть и пункты одной строкой (для проверки на дословные совпадения).
// options.title = false: заголовок не обязателен (переписывание, заголовок берётся из журнала).
function parseCardResponse(raw, options = {}) {
  const minRelevance = options.minRelevance ?? 6;
  const needTitle = options.title !== false;
  const fail = (reason, extra = {}) => ({ ok: false, relevance: null, card: null, text: '', reason, ...extra });

  const data = extractJson(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('ответ не JSON');

  const r = typeof data.relevance === 'string' ? Number(data.relevance.replace(',', '.')) : data.relevance;
  if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 10) return fail('оценка вне шкалы 0–10');
  const relevance = Math.round(r * 10) / 10;

  const title = clean(data.title).replace(/\s+/g, ' ').replace(/[.]$/, '');
  const lead = clean(data.lead).replace(/\s+/g, ' ');
  const points = (Array.isArray(data.points) ? data.points : [])
    .map((p) => clean(p).replace(/\s+/g, ' ').replace(/^[-•*–—▫️🔹\s]+/u, ''))
    .filter(Boolean)
    .slice(0, 5);
  const full = typeof data.full === 'string' ? clean(data.full).replace(/\n{3,}/g, '\n\n') : '';
  const text = [lead, ...points].join('\n');

  if (relevance < minRelevance) return fail('ниже порога релевантности', { relevance, text });
  if (needTitle && !title) return fail('нет заголовка', { relevance });
  if (needTitle && title.length > 120) return fail('слишком длинный заголовок', { relevance });
  if (lead.length < 20) return fail('слишком короткая суть', { relevance, text });
  if (lead.length > 400) return fail('слишком длинная суть', { relevance, text });
  if (points.some((p) => p.length > 200)) return fail('слишком длинный пункт', { relevance, text });
  if (JUNK.some((re) => re.test(text) || re.test(title) || re.test(full))) {
    return fail('похоже на отказ модели', { relevance, text });
  }

  const card = { emoji: pickEmoji(data.emoji), tag: pickTag(data.tag), title, lead, points, full };
  return { ok: true, relevance, card, text, reason: null };
}

if (typeof module !== 'undefined') {
  module.exports = { TAGS, DEFAULT_TAG, extractJson, parseModelResponse, parseCardResponse };
}
