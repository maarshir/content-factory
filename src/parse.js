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

if (typeof module !== 'undefined') {
  module.exports = { extractJson, parseModelResponse };
}
