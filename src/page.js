// Разбор страницы статьи: картинка для обложки и текст для подробного пересказа.
// Файл без зависимостей: вклеивается в узел Code n8n. Глобального URL в узлах
// n8n 2.x нет, поэтому адреса собираются вручную.
'use strict';

const TEXT_LIMIT = 6000;
const MIN_PARAGRAPH = 40;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•' };

function decode(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

// Адрес картинки относительно страницы: //host/a.jpg, /a.jpg и a.jpg.
function resolveUrl(raw, base) {
  const s = decode(String(raw || '').trim());
  if (!s || /^data:/i.test(s)) return '';
  if (/^https?:\/\//i.test(s)) return s;
  const m = /^(https?:)\/\/([^/?#]+)([^?#]*)/i.exec(String(base || ''));
  if (!m) return '';
  if (s.startsWith('//')) return m[1] + s;
  if (s.startsWith('/')) return `${m[1]}//${m[2]}${s}`;
  const dir = m[3].replace(/[^/]*$/, '') || '/';
  return `${m[1]}//${m[2]}${dir}${s}`;
}

// Значение тега <meta> по property или name, порядок атрибутов любой.
function meta(html, names) {
  const tags = String(html).match(/<meta\b[^>]*>/gi) || [];
  for (const name of names) {
    for (const tag of tags) {
      const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (!key || key[1].toLowerCase() !== name) continue;
      const val = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
      if (val && val[1].trim()) return val[1].trim();
    }
  }
  return '';
}

// Картинка статьи: og:image, затем twitter:image. Значки и счётчики не берутся.
function pageImage(html, link) {
  const raw = meta(html, ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']);
  const url = resolveUrl(raw, link);
  if (!url || /\.(svg|ico)(\?|$)/i.test(url) || /(logo|favicon|sprite|placeholder)/i.test(url)) return '';
  return url;
}

function stripTags(s) {
  return decode(String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// Основной текст: абзацы <p> и пункты списков из <article> (или всей страницы),
// без меню, подвала, скриптов и коротких строк. Не длиннее limit знаков.
function pageText(html, limit = TEXT_LIMIT) {
  let s = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|form|nav|footer|header|aside|button|select)\b[\s\S]*?<\/\1>/gi, ' ');
  const article = s.match(/<article\b[^>]*>([\s\S]*?)<\/article>/gi);
  if (article) {
    const longest = article.sort((a, b) => b.length - a.length)[0];
    if (stripTags(longest).length > 500) s = longest;
  }
  const parts = [];
  const seen = new Set();
  let total = 0;
  for (const m of s.matchAll(/<(p|li|h2|h3|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = stripTags(m[2]);
    const heading = /^h/i.test(m[1]);
    if (!t || seen.has(t) || (!heading && t.length < MIN_PARAGRAPH)) continue;
    if (/(cookie|подпиш(ись|итесь)|подпис(ывайтесь|аться)|реклама|все права защищены|©)/i.test(t)) continue;
    seen.add(t);
    if (total + t.length > limit) break;
    parts.push(t);
    total += t.length + 2;
  }
  // Подзаголовок без следующего за ним абзаца не нужен.
  while (parts.length && parts[parts.length - 1].length < MIN_PARAGRAPH) parts.pop();
  return parts.join('\n\n');
}

// Страница статьи -> { image, text }. Пустая или сломанная страница даёт пустые поля.
function parsePage(html, link, options = {}) {
  const s = typeof html === 'string' ? html : '';
  if (!/<html|<body|<article|<p\b/i.test(s)) return { image: '', text: '' };
  return { image: pageImage(s, link), text: pageText(s, options.limit ?? TEXT_LIMIT) };
}

if (typeof module !== 'undefined') {
  module.exports = { TEXT_LIMIT, decode, resolveUrl, pageImage, pageText, parsePage };
}
