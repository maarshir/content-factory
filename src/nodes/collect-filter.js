// Узел «Отбор»: записи лент -> отбор и отсев повторов (filter.js) с учётом журнала.
// Новое и отклонённое пишется в журнал, дальше идёт не больше MAX_ITEMS новостей.
// @include src/filter.js as filterLib
// @include src/log.js as logLib
// @include src/filter.config.json as FILTER_CONFIG

const { DatabaseSync } = require('node:sqlite');
const settings = $('Настройки').first().json;
const maxItems = Number(settings.MAX_ITEMS) || 5;

// Описание из ленты без тегов и лишних пробелов, не длиннее 1500 знаков.
function plain(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);
}

// Имя ленты берётся из узла «Ленты» по связи элементов; если связи нет, будет домен.
function sourceName(i) {
  try {
    return $('Ленты').itemMatching(i).json.name || null;
  } catch {
    return null;
  }
}

function rssImage(j) {
  const e = j && j.enclosure;
  const url = e && typeof e === 'object' ? String(e.url || '') : '';
  const type = e && typeof e === 'object' ? String(e.type || '') : '';
  return /^https?:\/\//i.test(url) && (/^image\//i.test(type) || /\.(jpe?g|png|webp)(\?|$)/i.test(url)) ? url : '';
}

const items = $input
  .all()
  .map((it, i) => ({
    title: String(it.json.title || '').trim(),
    link: String(it.json.link || '').trim(),
    description: plain(it.json.contentSnippet || it.json.content || it.json.description),
    source: sourceName(i),
    // Картинка из ленты (enclosure), запасная к картинке со страницы статьи.
    image: rssImage(it.json),
  }))
  // Ошибка чтения ленты приходит элементом без ссылки: такие пропускаются.
  .filter((x) => x.link);

const db = new DatabaseSync(settings.CF_DB_PATH);
try {
  // normalizeUrl передаётся явно: внутри n8n log.js не найдёт filter.js сам.
  const log = logLib.createLog(db, { normalizeUrl: filterLib.normalizeUrl });
  log.init();
  const { accepted, rejected } = filterLib.filterItems(items, FILTER_CONFIG, log.seen(14));

  // Повторы уже есть в журнале, остальные отказы записываются с причиной.
  for (const r of rejected) {
    if (r.reason === 'повтор ссылки' || r.reason === 'нет заголовка') continue;
    const c = log.collected(r);
    if (c.added) log.rejected(r.link, r.reason);
  }

  // Сверх MAX_ITEMS в журнал не пишется: эти новости придут в следующий запуск.
  const out = [];
  for (const a of accepted) {
    if (out.length >= maxItems) break;
    const c = log.collected(a);
    if (!c.added) continue;
    out.push({
      json: { id: c.item.id, title: a.title, link: a.link, description: a.description, source: a.source, image: a.image },
    });
  }
  return out;
} finally {
  db.close();
}
