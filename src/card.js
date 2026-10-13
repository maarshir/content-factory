// Части поста для Телеграма: страница Телеграфа с подробным пересказом,
// запрос обложки к сервису cover/ и хранение частей в журнале (поле card, JSON).
// Файл без зависимостей: вклеивается в узлы Code n8n.
'use strict';

// Подробный пересказ нужен только большой новости: статья не короче ARTICLE_MIN
// знаков, а пересказ не короче FULL_MIN. Иначе в посте остаётся только источник.
const ARTICLE_MIN = 1500;
const FULL_MIN = 600;

const CHANNEL = {
  name: 'Нейросети: главное за день',
  url: 'https://t.me/neiro_glav',
};

// Название, ссылка и короткое имя канала из «Настроек» (CHANNEL_NAME, CHANNEL_URL).
function channelOf(settings = {}) {
  const name = String(settings.CHANNEL_NAME ?? '').trim() || CHANNEL.name;
  const url = String(settings.CHANNEL_URL ?? '').trim() || CHANNEL.url;
  const m = /t\.me\/([A-Za-z0-9_]{4,})/.exec(url);
  return { name, url, handle: m ? '@' + m[1] : '' };
}

function needFull(card, article) {
  return Boolean(
    card && typeof card.full === 'string' && card.full.trim().length >= FULL_MIN && String(article || '').length >= ARTICLE_MIN
  );
}

// Тело запроса createPage Телеграфа (https://telegra.ph/api#createPage).
// Ключ access_token в учётных данных узла, здесь его нет.
function telegraphPage({ title, full, image, link, sourceName, channel }) {
  const ch = channel || CHANNEL;
  const paragraphs = String(full || '')
    .split(/\n{2,}|\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const content = [];
  if (image && /^https:\/\//i.test(image)) content.push({ tag: 'figure', children: [{ tag: 'img', attrs: { src: image } }] });
  for (const p of paragraphs) content.push({ tag: 'p', children: [p] });
  content.push({ tag: 'p', children: ['Источник: ', { tag: 'a', attrs: { href: link }, children: [sourceName || link] }] });
  content.push({ tag: 'p', children: [{ tag: 'a', attrs: { href: ch.url }, children: [ch.name] }] });
  return {
    title: String(title || '').slice(0, 256),
    author_name: String(ch.name).slice(0, 128),
    author_url: ch.url,
    content: JSON.stringify(content),
    return_content: false,
  };
}

// Ответ Телеграфа -> адрес страницы или ''.
function telegraphUrl(res) {
  const url = res && res.ok && res.result && res.result.url;
  return typeof url === 'string' && /^https:\/\/telegra\.ph\//.test(url) ? url : '';
}

// Тело запроса к сервису обложек (cover/server.js).
function coverRequest(card, channel) {
  const ch = channel || channelOf();
  return {
    title: card.title,
    tag: card.tag || '',
    image: card.image || '',
    channel: ch.name,
    handle: ch.handle,
  };
}

// Части поста из журнала: JSON в поле card или null у старых записей.
function readCard(raw) {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    return c && typeof c === 'object' && c.title ? c : null;
  } catch {
    return null;
  }
}

// В журнал без подробного пересказа: он уже на странице Телеграфа.
function storeCard(card) {
  const { emoji, tag, title, lead, points, image, telegraph } = card;
  return JSON.stringify({ emoji, tag, title, lead, points, image: image || '', telegraph: telegraph || '' });
}

if (typeof module !== 'undefined') {
  module.exports = { ARTICLE_MIN, FULL_MIN, CHANNEL, channelOf, needFull, telegraphPage, telegraphUrl, coverRequest, readCard, storeCard };
}
