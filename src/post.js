// Сборка поста из ответа нейросети: Телеграм и MAX (разметка HTML) или ВКонтакте (простой текст).
// Файл без зависимостей: функции можно вставить в узел Code n8n целиком.
// Разметка HTML (parse_mode: 'HTML'): в ней экранировать нужно только &, < и >.
'use strict';

// Лимит Телеграма на текст сообщения: 4096 знаков после разбора разметки,
// подпись к картинке 1024. Считается в единицах UTF-16, как у String.length.
const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;

// ВКонтакте: метод wall.post, текст в параметре message, разметка не поддерживается.
// Документация метода: https://dev.vk.com/ru/method/wall.post
// Предел длины message в описании метода не указан, поэтому здесь свой предел
// с запасом. Поменять можно через options.limit.
const VK_TEXT_LIMIT = 4096;

// MAX: метод POST /messages, текст до 4000 знаков, разметка по полю format
// (markdown или html). Документация: https://dev.max.ru/docs-api/methods/POST/messages
// Теги HTML: https://dev.max.ru/docs-api/use-cases/sending-messages/text-formatting
// Учитывается ли разметка в пределе, не сказано, поэтому длина считается по всему
// тексту вместе с тегами.
const MAX_TEXT_LIMIT = 4000;
const MAX_FORMAT = 'html';

// Площадки, для которых есть сборка поста и промпт prompts/<площадка>.md.
const PLATFORMS = ['telegram', 'vk', 'max'];

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// Разбор ссылки: { protocol, hostname, href } или null, если ссылка нечитаемая.
// В узлах Code n8n 2.x (отдельный процесс task runner) глобального URL нет,
// тогда ссылка разбирается регулярным выражением.
function parseLink(raw) {
  const s = String(raw || '').trim();
  if (typeof URL === 'function') {
    try {
      const u = new URL(s);
      return { protocol: u.protocol, hostname: u.hostname, href: u.href };
    } catch {
      return null;
    }
  }
  const m = /^([a-z][a-z0-9+.-]*):(\/\/([^/?#\s]*))?(\S*)$/i.exec(s);
  if (!m) return null;
  const protocol = m[1].toLowerCase() + ':';
  const hostname = (m[3] || '').replace(/^[^@]*@/, '').replace(/:\d*$/, '').toLowerCase();
  if ((protocol === 'http:' || protocol === 'https:') && !hostname) return null;
  return { protocol, hostname, href: s };
}

// Ссылка на источник обязательна: без неё или с нечитаемой ссылкой пост не собирается.
function sourceUrl(link) {
  const u = parseLink(link);
  if (!u) throw new Error('нет ссылки на источник');
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

// Пост для ВКонтакте: простой текст без HTML. Заголовок первой строкой,
// затем текст и подпись источника, ссылка последней отдельной строкой
// (ВКонтакте сам делает её кликабельной). Длина считается по всему тексту.
function buildVkPost({ title, text, link, sourceName } = {}, options = {}) {
  const url = sourceUrl(link);
  const limit = options.limit ?? VK_TEXT_LIMIT;
  const name = String(sourceName || '').trim() || url.hostname.replace(/^www\./, '');
  const head = String(title || '').replace(/\s+/g, ' ').trim();
  const body = String(text || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!body) throw new Error('пустой текст поста');

  const tail = `Источник: ${name}\n${url.href}`;
  const fixed = (head ? head.length + 2 : 0) + 2 + tail.length;
  const room = limit - fixed;
  if (room < 20) throw new Error('не хватает места для текста поста');
  const visibleBody = truncate(body, room);

  const out = (head ? `${head}\n\n` : '') + `${visibleBody}\n\n${tail}`;
  return { text: out, visibleLength: out.length, truncated: visibleBody !== body };
}

// Пост для MAX: та же разметка HTML, что у Телеграма (<b> и <a> есть в обоих),
// заголовок жирным, текст, ссылка на источник отдельной строкой. Отправляется
// с format: 'html'. Длина считается по всему тексту с тегами и сущностями.
function buildMaxPost({ title, text, link, sourceName } = {}, options = {}) {
  const url = sourceUrl(link);
  const limit = options.limit ?? MAX_TEXT_LIMIT;
  const name = String(sourceName || '').trim() || url.hostname.replace(/^www\./, '');
  const head = String(title || '').replace(/\s+/g, ' ').trim();
  const body = String(text || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!body) throw new Error('пустой текст поста');

  const headHtml = head ? `<b>${escapeHtml(head)}</b>\n\n` : '';
  const tail = `\n\nИсточник: <a href="${escapeAttr(url.href)}">${escapeHtml(name)}</a>`;
  const room = limit - headHtml.length - tail.length;
  if (room < 20) throw new Error('не хватает места для текста поста');
  // Экранирование удлиняет текст, поэтому обрезка повторяется, пока он не влезет.
  let visibleBody = truncate(body, room);
  while (escapeHtml(visibleBody).length > room) {
    visibleBody = truncate(body, visibleBody.length - (escapeHtml(visibleBody).length - room));
  }
  const out = headHtml + escapeHtml(visibleBody) + tail;
  return { text: out, format: MAX_FORMAT, visibleLength: out.length, truncated: visibleBody !== body };
}

const POINT_MARK = '🔹';

// Видимая длина текста с разметкой HTML Телеграма: без тегов, сущность как один знак.
function visibleLength(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(lt|gt|amp|quot|#39);/g, '_').length;
}

// Пост по частям от нейросети для Телеграма, подписью к обложке (до 1024 знаков):
//   эмодзи и заголовок жирным, суть, пункты в цитате, ссылки, хэштег рубрики.
//   🧠 <b>Заголовок</b>
//
//   Суть в одном-двух предложениях.
//
//   <blockquote>🔹 пункт
//   🔹 пункт</blockquote>
//
//   📖 Читать подробнее · 🔗 Хабр
//   #модели
// Подробный пересказ (telegraph) необязателен: без него остаётся только источник.
// Не влезает: сначала убираются пункты с конца, потом обрезается суть.
function buildCardPost(card = {}, options = {}) {
  const url = sourceUrl(card.link);
  const limit = options.limit ?? TELEGRAM_CAPTION_LIMIT;
  const name = String(card.sourceName || '').trim() || url.hostname.replace(/^www\./, '');
  const title = String(card.title || '').replace(/\s+/g, ' ').trim();
  const lead = String(card.lead || '').replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('нет заголовка');
  if (!lead) throw new Error('пустой текст поста');
  const emoji = String(card.emoji || '').trim();
  const tag = String(card.tag || '').trim().replace(/\s+/g, '_');
  let points = (card.points || []).map((p) => String(p).replace(/\s+/g, ' ').trim()).filter(Boolean);
  const more = parseLink(card.telegraph);
  const moreOk = more && more.protocol === 'https:';

  const links = moreOk
    ? `📖 <a href="${escapeAttr(more.href)}">Читать подробнее</a> · 🔗 <a href="${escapeAttr(url.href)}">${escapeHtml(name)}</a>`
    : `🔗 Источник: <a href="${escapeAttr(url.href)}">${escapeHtml(name)}</a>`;
  const head = `${emoji ? emoji + ' ' : ''}<b>${escapeHtml(title)}</b>`;
  const foot = links + (tag ? `\n#${escapeHtml(tag)}` : '');

  const compose = (body, list) =>
    `${head}\n\n${escapeHtml(body)}\n\n` +
    (list.length ? `<blockquote>${list.map((p) => `${POINT_MARK} ${escapeHtml(p)}`).join('\n')}</blockquote>\n\n` : '') +
    foot;

  let body = lead;
  let html = compose(body, points);
  while (visibleLength(html) > limit && points.length) {
    points = points.slice(0, -1);
    html = compose(body, points);
  }
  if (visibleLength(html) > limit) {
    const room = limit - visibleLength(compose('', []));
    if (room < 20) throw new Error('не хватает места для текста поста');
    body = truncate(lead, room);
    html = compose(body, []);
  }
  const truncated = body !== lead || points.length < (card.points || []).filter((p) => String(p).trim()).length;
  return { text: html, parse_mode: 'HTML', visibleLength: visibleLength(html), truncated };
}

// Площадка из поля PLATFORM узла «Настройки»; пусто значит telegram.
function platformOf(settings = {}) {
  const p = String((settings && settings.PLATFORM) ?? '').trim().toLowerCase() || 'telegram';
  if (!PLATFORMS.includes(p)) throw new Error(`неизвестная площадка: ${p}`);
  return p;
}

// Сборка поста для выбранной площадки.
function buildPostFor(platform, fields, options = {}) {
  if (platform === 'vk') return buildVkPost(fields, options);
  if (platform === 'max') return buildMaxPost(fields, options);
  if (platform === 'telegram') return buildPost(fields, options);
  throw new Error(`неизвестная площадка: ${platform}`);
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
    VK_TEXT_LIMIT,
    MAX_TEXT_LIMIT,
    MAX_FORMAT,
    PLATFORMS,
    escapeHtml,
    parseLink,
    truncate,
    buildPost,
    buildVkPost,
    buildMaxPost,
    buildPostFor,
    buildCardPost,
    visibleLength,
    platformOf,
    fillPrompt,
  };
}
