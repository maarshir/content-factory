// Отбор новостей перед нейросетью: ключевые слова и отсев повторов.
// Файл без зависимостей: функции можно вставить в узел Code n8n целиком.
'use strict';

const TRACKING = /^(utm_\w+|fbclid|gclid|yclid|ref|from)$/i;

// Приводит текст к виду для сравнения: нижний регистр, ё -> е, только буквы и цифры.
function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokens(s) {
  const t = normalizeText(s);
  return t ? t.split(' ') : [];
}

// Одна и та же статья по разным ссылкам: без схемы, www, якоря, меток utm и
// конечной косой черты. Нечитаемая ссылка возвращается как есть после trim.
function normalizeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const u = splitUrl(raw);
  if (!u) return raw.toLowerCase();
  const params = u.params
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? '?' + params.map(([k, v]) => formEncode(k) + '=' + formEncode(v)).join('&') : '';
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const p = u.pathname.replace(/\/+$/, '');
  return host + p + query;
}

// Кодирование как у URLSearchParams.toString(): пробел как +, остальное через %.
function formEncode(s) {
  return encodeURIComponent(s)
    .replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
}

function formDecode(s) {
  const t = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
}

// Части ссылки: { hostname, pathname, params: [[ключ, значение]] } или null.
// В узлах Code n8n 2.x (отдельный процесс task runner) глобального URL нет,
// тогда ссылка разбирается регулярным выражением.
function splitUrl(raw) {
  if (typeof URL === 'function') {
    let u;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    return { hostname: u.hostname, pathname: u.pathname, params: [...u.searchParams.entries()] };
  }
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)([^?#\s]*)(\?[^#\s]*)?(#\S*)?$/i.exec(raw);
  if (!m) return null;
  const hostname = m[1].replace(/^[^@]*@/, '').replace(/:\d*$/, '');
  if (!hostname) return null;
  const params = (m[3] || '')
    .slice(1)
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf('=');
      return i < 0 ? [formDecode(pair), ''] : [formDecode(pair.slice(0, i)), formDecode(pair.slice(i + 1))];
    });
  // Как URL: буквы не из ASCII в пути кодируются через %.
  const pathname = (m[2] || '/').replace(/[^\x00-\x7f]+/g, (c) => encodeURIComponent(c));
  return { hostname, pathname, params };
}

// Ключевое слово из нескольких слов ищется как фраза, каждое слово как начало
// слова в тексте («нейросет» найдёт «нейросети»). Короткие слова до трёх букв
// ищутся только целиком, чтобы «ИИ» не находилось внутри других слов.
function keywordMatches(textTokens, keyword) {
  const kw = tokens(keyword);
  if (!kw.length) return false;
  for (let i = 0; i + kw.length <= textTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < kw.length; j++) {
      const t = textTokens[i + j];
      const k = kw[j];
      if (k.length <= 3 ? t !== k : !t.startsWith(k)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function findKeywords(text, keywords) {
  const tt = tokens(text);
  return (keywords || []).filter((k) => keywordMatches(tt, k));
}

// Похожесть заголовков: коэффициент Жаккара по множествам основ слов
// (первые stemLength букв). Грубо, но переживает разные окончания в русском.
function titleSimilarity(a, b, stemLength = 5) {
  const stem = (s) => new Set(tokens(s).map((t) => t.slice(0, stemLength)));
  const A = stem(a);
  const B = stem(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// items: [{ title, link, description }]. seen: уже собранные раньше записи
// с теми же полями (из журнала). Возвращает принятые и отклонённые с причиной.
function filterItems(items, config = {}, seen = []) {
  const keywords = config.keywords || [];
  const exclude = config.exclude || [];
  const threshold = config.similarityThreshold ?? 0.6;
  const stemLength = config.stemLength ?? 5;

  const accepted = [];
  const rejected = [];
  const seenUrls = new Set(seen.map((s) => normalizeUrl(s.link)).filter(Boolean));
  const seenTitles = seen.map((s) => s.title).filter(Boolean);

  for (const item of items || []) {
    const title = String((item && item.title) || '').trim();
    const reject = (reason, extra = {}) => rejected.push({ ...item, reason, ...extra });

    if (!title) {
      reject('нет заголовка');
      continue;
    }
    const url = normalizeUrl(item.link);
    if (url && seenUrls.has(url)) {
      reject('повтор ссылки');
      continue;
    }
    const text = title + ' ' + (item.description || '');
    const bad = findKeywords(text, exclude);
    if (bad.length) {
      reject('стоп-слово', { matched: bad });
      continue;
    }
    const matched = findKeywords(text, keywords);
    if (keywords.length && !matched.length) {
      reject('нет ключевых слов');
      continue;
    }
    let dup = null;
    for (const t of seenTitles) {
      const sim = titleSimilarity(title, t, stemLength);
      if (sim >= threshold) {
        dup = { duplicateOf: t, similarity: Math.round(sim * 100) / 100 };
        break;
      }
    }
    if (dup) {
      reject('похожий заголовок', dup);
      continue;
    }
    accepted.push({ ...item, matched });
    if (url) seenUrls.add(url);
    seenTitles.push(title);
  }
  return { accepted, rejected };
}

if (typeof module !== 'undefined') {
  module.exports = { normalizeText, normalizeUrl, findKeywords, titleSimilarity, filterItems };
}
