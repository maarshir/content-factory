const { test } = require('node:test');
const assert = require('node:assert');
const { createLog } = require('../src/log.js');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {}
const skip = DatabaseSync ? false : 'нет node:sqlite (нужен Node 22.5+)';

function setup() {
  const log = createLog(new DatabaseSync(':memory:'));
  log.init();
  return log;
}

const news = (n) => ({ link: `https://example.com/news/${n}`, title: `Новость номер ${n}`, source: 'Пример' });

test('черновик сохраняется у собранной записи и находится по номеру', { skip }, () => {
  const log = setup();
  const { item } = log.collected(news(1));
  const d = log.drafted(news(1).link, '<b>Текст</b>', { relevance: 8 });
  assert.strictEqual(d.status, 'collected');
  assert.strictEqual(d.post, '<b>Текст</b>');
  assert.strictEqual(d.relevance, 8);
  assert.strictEqual(log.byId(item.id).post, '<b>Текст</b>');
  assert.strictEqual(log.byId(9999), null);
});

test('пустой черновик и черновик отклонённой записи не проходят', { skip }, () => {
  const log = setup();
  log.collected(news(1));
  assert.throws(() => log.drafted(news(1).link, '  '), /пустой/);
  log.rejected(news(1).link, 'нет ключевых слов');
  assert.throws(() => log.drafted(news(1).link, 'текст'), /только для collected/);
  assert.throws(() => log.drafted(news(2).link, 'текст'), /нет в журнале/);
});

test('очередь: только с черновиком, затем публикация или отказ', { skip }, () => {
  const log = setup();
  log.collected(news(1));
  assert.throws(() => log.queued(news(1).link), /только с черновиком/);
  log.drafted(news(1).link, 'текст 1');
  const q = log.queued(news(1).link);
  assert.strictEqual(q.status, 'queued');
  assert.ok(q.queued_at);
  assert.throws(() => log.queued(news(1).link), /нельзя перейти из queued в queued/);
  assert.throws(() => log.drafted(news(1).link, 'другой'), /только для collected/);
  const p = log.published(news(1).link, 7);
  assert.strictEqual(p.status, 'published');
  assert.strictEqual(p.queued_at, q.queued_at);

  log.collected(news(2));
  log.drafted(news(2).link, 'текст 2');
  log.queued(news(2).link);
  assert.strictEqual(log.rejected(news(2).link, 'передумал редактор').status, 'rejected');
  const s = log.stats();
  assert.deepStrictEqual([s.queued, s.published, s.rejected, s.total], [0, 1, 1, 2]);
});

test('журнал старой схемы переносится без потери записей', { skip }, () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, url_key TEXT NOT NULL UNIQUE, link TEXT NOT NULL,
    title TEXT NOT NULL, source TEXT,
    status TEXT NOT NULL CHECK (status IN ('collected', 'rejected', 'published')),
    reason TEXT, relevance REAL, message_id TEXT, post TEXT,
    collected_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT);
    CREATE INDEX items_status ON items (status);
    INSERT INTO items (url_key, link, title, status, post, collected_at, updated_at)
    VALUES ('example.com/news/1', 'https://example.com/news/1', 'Старая', 'collected', 'черновик', 't', 't');`);
  const log = createLog(db);
  log.init();
  log.init();
  const old = log.byId(1);
  assert.strictEqual(old.title, 'Старая');
  assert.strictEqual(log.queued(old.link).status, 'queued');
  assert.strictEqual(log.collected(news(2)).item.id, 2);
});
