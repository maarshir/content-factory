// Журнал конвейера в SQLite: что собрано, что отклонено и почему, что опубликовано.
// Работает с любым объектом базы, у которого есть exec(sql) и prepare(sql) с
// методами run/get/all: node:sqlite (DatabaseSync) или better-sqlite3.
'use strict';

const STATUSES = ['collected', 'queued', 'rejected', 'published'];

// Разрешённые переходы. queued: редактор нажал «Опубликовать», пост ждёт
// отправки в канал. Опубликованное не откатывается: если пост удалили из
// канала, это отдельное событие, его в журнал пишет человек.
const TRANSITIONS = {
  collected: ['queued', 'rejected', 'published'],
  queued: ['published', 'rejected'],
  rejected: ['collected'],
  published: [],
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url_key TEXT NOT NULL UNIQUE,
  link TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT,
  status TEXT NOT NULL CHECK (status IN ('collected', 'queued', 'rejected', 'published')),
  reason TEXT,
  relevance REAL,
  message_id TEXT,
  post TEXT,
  collected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  queued_at TEXT,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS items_status ON items (status);
CREATE INDEX IF NOT EXISTS items_collected_at ON items (collected_at);
`;

function defaultNormalizeUrl() {
  try {
    return require('./filter.js').normalizeUrl;
  } catch {
    // В узле Code без filter.js: только trim и нижний регистр.
    return (u) => String(u || '').trim().toLowerCase();
  }
}

function createLog(db, options = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('нужен объект базы с exec и prepare');
  }
  const now = options.now || (() => new Date().toISOString());
  const normalizeUrl = options.normalizeUrl || defaultNormalizeUrl();

  const keyOf = (link) => {
    const key = normalizeUrl(link);
    if (!key) throw new Error('нет ссылки');
    return key;
  };

  const get = (key) => db.prepare('SELECT * FROM items WHERE url_key = ?').get(key) || null;

  // Журнал старой схемы (без статуса queued) переносится в новую таблицу с теми же записями.
  function init() {
    const old = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items'").get();
    if (old && !String(old.sql).includes("'queued'")) {
      const cols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name).join(', ');
      db.exec('BEGIN');
      try {
        db.exec('ALTER TABLE items RENAME TO items_old; DROP INDEX IF EXISTS items_status; DROP INDEX IF EXISTS items_collected_at;');
        db.exec(SCHEMA);
        db.exec(`INSERT INTO items (${cols}) SELECT ${cols} FROM items_old; DROP TABLE items_old;`);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return;
    }
    db.exec(SCHEMA);
  }

  // Новая запись или повтор уже известной ссылки. Повтор не создаёт строку и
  // не меняет статус: возвращает { added: false, item } с прежней записью.
  function collected(item) {
    const link = String((item && item.link) || '').trim();
    const title = String((item && item.title) || '').trim();
    if (!title) throw new Error('нет заголовка');
    const key = keyOf(link);
    const old = get(key);
    if (old) return { added: false, item: old };
    const t = now();
    db.prepare(
      `INSERT INTO items (url_key, link, title, source, status, collected_at, updated_at)
       VALUES (?, ?, ?, ?, 'collected', ?, ?)`
    ).run(key, link, title, item.source || null, t, t);
    return { added: true, item: get(key) };
  }

  function move(link, status, fields) {
    const key = keyOf(link);
    const old = get(key);
    if (!old) throw new Error(`нет в журнале: ${link}`);
    if (!TRANSITIONS[old.status].includes(status)) {
      throw new Error(`нельзя перейти из ${old.status} в ${status}`);
    }
    const t = now();
    db.prepare(
      `UPDATE items SET status = ?, reason = ?, relevance = ?, message_id = ?,
       queued_at = ?, published_at = ?, updated_at = ? WHERE url_key = ?`
    ).run(
      status,
      fields.reason ?? null,
      fields.relevance ?? old.relevance ?? null,
      fields.messageId ?? old.message_id ?? null,
      status === 'queued' ? t : status === 'published' ? old.queued_at ?? null : null,
      status === 'published' ? t : null,
      t,
      key
    );
    return get(key);
  }

  // Причина обязательна: журнал нужен, чтобы видеть, почему новость не прошла.
  function rejected(link, reason, extra = {}) {
    const r = String(reason || '').trim();
    if (!r) throw new Error('у отказа должна быть причина');
    return move(link, 'rejected', { reason: r, relevance: extra.relevance });
  }

  function published(link, messageId, extra = {}) {
    if (messageId === undefined || messageId === null || String(messageId).trim() === '') {
      throw new Error('нет номера сообщения в канале');
    }
    return move(link, 'published', { messageId: String(messageId), relevance: extra.relevance });
  }

  // Редактор нажал «Опубликовать»: пост с черновиком встаёт в очередь на отправку в канал.
  function queued(link) {
    const old = get(keyOf(link));
    if (old && !old.post) throw new Error('в очередь только с черновиком');
    return move(link, 'queued', {});
  }

  // Черновик поста от нейросети (HTML для Телеграма) для записи в статусе collected.
  // Статус не меняется: публикует редактор кнопкой в боте.
  function drafted(link, post, extra = {}) {
    const text = String(post ?? '').trim();
    if (!text) throw new Error('пустой черновик');
    const key = keyOf(link);
    const old = get(key);
    if (!old) throw new Error(`нет в журнале: ${link}`);
    if (old.status !== 'collected') throw new Error(`черновик только для collected, сейчас ${old.status}`);
    db.prepare('UPDATE items SET post = ?, relevance = ?, updated_at = ? WHERE url_key = ?').run(
      text,
      extra.relevance ?? old.relevance ?? null,
      now(),
      key
    );
    return get(key);
  }

  // Запись по номеру: кнопки бота редактора передают номер, ссылка в 64 байта не влезает.
  function byId(id) {
    return db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id)) || null;
  }

  // Редактор вернул отклонённое в работу («Переписать»).
  function reopen(link) {
    return move(link, 'collected', {});
  }

  // Записи за последние days дней в виде { link, title } для filterItems(items, config, seen).
  function seen(days = 14) {
    const since = new Date(Date.parse(now()) - days * 86400000).toISOString();
    return db
      .prepare('SELECT link, title FROM items WHERE collected_at >= ? ORDER BY id')
      .all(since)
      .map((r) => ({ link: r.link, title: r.title }));
  }

  // Сводка: сколько в каждом статусе и самые частые причины отказа.
  function stats() {
    const counts = { collected: 0, queued: 0, rejected: 0, published: 0 };
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM items GROUP BY status').all()) {
      counts[r.status] = Number(r.n);
    }
    const reasons = db
      .prepare(
        `SELECT reason, COUNT(*) AS n FROM items WHERE status = 'rejected'
         GROUP BY reason ORDER BY n DESC, reason`
      )
      .all()
      .map((r) => ({ reason: r.reason, count: Number(r.n) }));
    return { ...counts, total: counts.collected + counts.queued + counts.rejected + counts.published, reasons };
  }

  return { init, collected, drafted, queued, rejected, published, reopen, seen, stats, byId, get: (link) => get(keyOf(link)) };
}

if (typeof module !== 'undefined') {
  module.exports = { SCHEMA, STATUSES, TRANSITIONS, createLog };
}
