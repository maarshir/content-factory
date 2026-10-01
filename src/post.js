// Сборка поста для Телеграма из ответа нейросети.
// Файл без зависимостей: функции можно вставить в узел Code n8n целиком.
// Разметка HTML (parse_mode: 'HTML'): в ней экранировать нужно только &, < и >.
'use strict';

// Лимит Телеграма на текст сообщения: 4096 знаков после разбора разметки,
// подпись к картинке 1024. Считается в единицах UTF-16, как у String.length.
const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// Ссылка на источник обязательна: без неё или с нечитаемой ссылкой пост не собирается.
function sourceUrl(link) {
  let u;
  try {
    u = new URL(String(link || '').trim());
  } catch {
    throw new Error('нет ссылки на источник');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('ссылка на источник не http(s)');
  return u;
}

// Обрезает текст до limit знаков: по концу предложения, если он не слишком
// далеко, иначе по пробелу, и ставит многоточие. Суррогатные пары не рвёт.
function truncate(text, limit) {
  const s = String(text ?? '').trim();
  if (s.length <= limit) return s;
  if (limit <= 1) return '…'.slice(0, Math.max(0, limit));
  let cut = s.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence >= cut.length * 0.6) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(' ');
  if (space >= cut.length * 0.6) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:.\-]+$/, '') + '…';
}

// Собирает пост: заголовок жирным, текст, ссылка на источник отдельной строкой.
// Длина считается по видимому тексту (без тегов, сущности как один знак).
// options.caption: true, если пост идёт подписью к картинке (лимит 1024).
function buildPost({ title, text, link, sourceName } = {}, options = {}) {
  const url = sourceUrl(link);
  const limit = options.limit ?? (options.caption ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT);
  const name = String(sourceName || '').trim() || url.hostname.replace(/^www\./, '');
  const head = String(title || '').trim();
  const body = String(text || '').trim();
  if (!body) throw new Error('пустой текст поста');

  const sourceLine = `Источник: ${name}`;
  const fixed = (head ? head.length + 2 : 0) + 2 + sourceLine.length;
  const room = limit - fixed;
  if (room < 20) throw new Error('не хватает места для текста поста');
  const visibleBody = truncate(body, room);

  const html =
    (head ? `<b>${escapeHtml(head)}</b>\n\n` : '') +
    `${escapeHtml(visibleBody)}\n\n` +
    `Источник: <a href="${escapeAttr(url.href)}">${escapeHtml(name)}</a>`;
  const visibleLength = (head ? head.length + 2 : 0) + visibleBody.length + 2 + sourceLine.length;
  return { text: html, parse_mode: 'HTML', visibleLength, truncated: visibleBody !== body };
}

// Подставляет поля новости в шаблон промпта: {{title}}, {{description}}, {{link}}, {{maxLength}}.
// Неизвестная подстановка остаётся видимой, чтобы ошибку в шаблоне было легко заметить.
function fillPrompt(template, vars = {}) {
  return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] ?? '') : m
  );
}

if (typeof module !== 'undefined') {
  module.exports = {
    TELEGRAM_TEXT_LIMIT,
    TELEGRAM_CAPTION_LIMIT,
    escapeHtml,
    truncate,
    buildPost,
    fillPrompt,
  };
}
