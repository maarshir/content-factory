// Очередь публикации поверх журнала log.js: какой пост отправить в канал следующим
// и что делать, если Телеграм его не принял. Та же база, что у createLog
// (node:sqlite или better-sqlite3); вызывать init() после log.init().
'use strict';

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (s) => {
  const m = String(s).match(TIME);
  if (!m) throw new Error(`время в виде ЧЧ:ММ, получено: ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
};

// Настройки из publish.config.json с проверкой и значениями по умолчанию.
function checkPublishConfig(config = {}) {
  const minIntervalMinutes = Number(config.minIntervalMinutes ?? 60);
  if (!Number.isFinite(minIntervalMinutes) || minIntervalMinutes < 0) throw new Error('minIntervalMinutes: число от 0');
  const maxAttempts = Number(config.maxAttempts ?? 3);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts: целое от 1');
  const timeZone = config.timeZone || 'Europe/Moscow';
  // Неизвестный часовой пояс Intl отвергает сразу.
  new Intl.DateTimeFormat('en-GB', { timeZone });
  const quietHours = config.quietHours
    ? { from: toMinutes(config.quietHours.from), to: toMinutes(config.quietHours.to) }
    : null;
  return { minIntervalMinutes, maxAttempts, timeZone, quietHours };
}

// Попадает ли момент ms в тихие часы { from, to } (минуты от полуночи) по местному времени.
// from > to: интервал через полночь (23:00–08:00); from == to: тихих часов нет.
function inQuietHours(ms, quiet, timeZone) {
  if (quiet.from === quiet.to) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const part = (type) => Number(parts.find((p) => p.type === type).value);
  const m = part('hour') * 60 + part('minute');
  return quiet.from < quiet.to ? m >= quiet.from && m < quiet.to : m >= quiet.from || m < quiet.to;
}

function createQueue(db, options = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('нужен объект базы с exec и prepare');
  }
  const now = options.now || (() => new Date().toISOString());
  const byId = (id) => db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id)) || null;

  // Счётчик неудачных отправок; журнал без него получает столбец с нулём.
  // false: журнала ещё нет (конвейер сбора не запускался), публиковать нечего.
  // Журнал прежней схемы переносит log.init(), до этого очередь его не трогает.
  function init() {
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items'").get();
    if (!table) return false;
    if (!String(table.sql).includes("'queued'")) throw new Error('журнал прежней схемы: сначала log.init()');
    const cols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
    if (!cols.includes('attempts')) db.exec('ALTER TABLE items ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    return true;
  }

  // Следующий пост или причина подождать: { item, wait }, где wait = null (можно отправлять),
  // 'quiet' (тихие часы), 'interval' (с прошлой публикации меньше minIntervalMinutes),
  // 'empty' (в очереди нечего отправлять). Первым идёт поставленный в очередь раньше.
  // Пост, который Телеграм не принял maxAttempts раз, остаётся в очереди с ошибкой,
  // но пропускается, чтобы не держать остальные.
  function next(config = {}) {
    const cfg = checkPublishConfig(config);
    const ms = Date.parse(now());
    if (cfg.quietHours && inQuietHours(ms, cfg.quietHours, cfg.timeZone)) return { item: null, wait: 'quiet' };
    const last = db.prepare("SELECT MAX(published_at) AS t FROM items WHERE status = 'published'").get();
    if (last && last.t && ms - Date.parse(last.t) < cfg.minIntervalMinutes * 60000) {
      return { item: null, wait: 'interval' };
    }
    const item =
      db
        .prepare(
          `SELECT * FROM items WHERE status = 'queued' AND post IS NOT NULL AND attempts < ?
           ORDER BY queued_at, id LIMIT 1`
        )
        .get(cfg.maxAttempts) || null;
    return { item, wait: item ? null : 'empty' };
  }

  // Площадка не приняла пост: он остаётся в очереди, в reason ошибка, счётчик растёт.
  // platform: telegram (по умолчанию) или vk, от неё зависит подпись ошибки.
  function failed(id, error, platform = 'telegram') {
    const old = byId(id);
    if (!old) throw new Error(`нет в журнале: ${id}`);
    if (old.status !== 'queued') throw new Error(`ошибка отправки только для queued, сейчас ${old.status}`);
    const text = String(error ?? '').trim().slice(0, 300) || 'неизвестная ошибка';
    db.prepare('UPDATE items SET reason = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?').run(
      (platform === 'vk' ? 'ошибка ВКонтакте: ' : 'ошибка Телеграма: ') + text,
      now(),
      old.id
    );
    return byId(old.id);
  }

  // Площадка приняла пост: статус published и номер сообщения в канале (у ВКонтакте номер записи на стене), ошибка стирается.
  // Те же правила, что у log.published, только по номеру записи из узла «Следующий пост».
  function published(id, messageId) {
    if (messageId === undefined || messageId === null || String(messageId).trim() === '') {
      throw new Error('нет номера сообщения в канале');
    }
    const old = byId(id);
    if (!old) throw new Error(`нет в журнале: ${id}`);
    if (old.status !== 'queued') throw new Error(`публикация только из queued, сейчас ${old.status}`);
    const t = now();
    db.prepare(
      `UPDATE items SET status = 'published', message_id = ?, reason = NULL, published_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(String(messageId), t, t, old.id);
    return byId(old.id);
  }

  return { init, next, failed, published };
}

if (typeof module !== 'undefined') {
  module.exports = { checkPublishConfig, inQuietHours, createQueue };
}
