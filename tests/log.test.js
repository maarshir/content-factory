const { test } = require('node:test');
const assert = require('node:assert');
const { createLog, SCHEMA } = require('../src/log.js');
const { filterItems } = require('../src/filter.js');

// node:sqlite есть в Node 22.5 и новее. В Node 20 тесты с базой пропускаются,
// полный прогон идёт в tests.yml на Node 22.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {}
const skip = DatabaseSync ? false : 'нет node:sqlite (нужен Node 22.5+)';

function setup() {
  let t = Date.parse('2026-10-01T10:00:00Z');
  const clock = { tick: (ms = 1000) => (t += ms) };
  const db = new DatabaseSync(':memory:');
  const log = createLog(db, { now: () => new Date(t).toISOString() });
  log.init();
  return { db, log, clock };
}

const news = (n, extra = {}) => ({
  link: `https://example.com/news/${n}`,
  title: `Новость номер ${n}`,
  source: 'Пример',
  ...extra,
});

test('без объекта базы журнал не создаётся', () => {
  assert.throws(() => createLog(null), TypeError);
  assert.throws(() => createLog({ exec() {} }), TypeError);
});

test('в схеме четыре статуса и уникальная ссылка', () => {
  assert.match(SCHEMA, /url_key TEXT NOT NULL UNIQUE/);
  assert.match(SCHEMA, /'collected', 'queued', 'rejected', 'published'/);
});

test('собрано, отклонено с причиной, опубликовано', { skip }, () => {
  const { log } = setup();
  log.collected(news(1));
  log.collected(news(2));
  log.collected(news(3));
  const r = log.rejected(news(2).link, 'нет ключевых слов');
  assert.strictEqual(r.status, 'rejected');
  assert.strictEqual(r.reason, 'нет ключевых слов');
  const p = log.published(news(3).link, 42, { relevance: 8 });
  assert.strictEqual(p.status, 'published');
  assert.strictEqual(p.message_id, '42');
  assert.strictEqual(p.relevance, 8);
  assert.ok(p.published_at);
  assert.deepStrictEqual(log.stats(), {
    collected: 1,
    queued: 0,
    rejected: 1,
    published: 1,
    total: 3,
    reasons: [{ reason: 'нет ключевых слов', count: 1 }],
  });
});

test('повтор ссылки с метками utm не создаёт новую запись', { skip }, () => {
  const { log } = setup();
  assert.strictEqual(log.collected(news(1)).added, true);
  const again = log.collected(news(1, { link: 'https://www.example.com/news/1/?utm_source=tg#top' }));
  assert.strictEqual(again.added, false);
  assert.strictEqual(log.stats().total, 1);
});

test('повтор не меняет статус уже опубликованной записи', { skip }, () => {
  const { log } = setup();
  log.collected(news(1));
  log.published(news(1).link, 7);
  assert.strictEqual(log.collected(news(1)).item.status, 'published');
});

test('отказ без причины и публикация без номера сообщения не проходят', { skip }, () => {
  const { log } = setup();
  log.collected(news(1));
  assert.throws(() => log.rejected(news(1).link, '  '), /причин/);
  assert.throws(() => log.published(news(1).link, ''), /номера сообщения/);
  assert.strictEqual(log.get(news(1).link).status, 'collected');
});

test('нельзя опубликовать отклонённое и отменить публикацию', { skip }, () => {
  const { log } = setup();
  log.collected(news(1));
  log.rejected(news(1).link, 'похожий заголовок');
  assert.throws(() => log.published(news(1).link, 1), /rejected в published/);
  log.reopen(news(1).link);
  log.published(news(1).link, 1);
  assert.throws(() => log.rejected(news(1).link, 'поздно'), /published в rejected/);
  assert.throws(() => log.reopen(news(1).link), /published в collected/);
});

test('после возврата в работу причина отказа стирается', { skip }, () => {
  const { log } = setup();
  log.collected(news(1));
  log.rejected(news(1).link, 'оценка ниже порога');
  assert.strictEqual(log.reopen(news(1).link).reason, null);
});

test('неизвестная ссылка и запись без заголовка', { skip }, () => {
  const { log } = setup();
  assert.throws(() => log.rejected('https://example.com/none', 'x'), /нет в журнале/);
  assert.throws(() => log.collected({ link: 'https://example.com/a', title: ' ' }), /заголовка/);
  assert.throws(() => log.collected({ title: 'Без ссылки' }), /ссылки/);
});

test('seen отдаёт записи за последние дни для filterItems', { skip }, () => {
  const { log, clock } = setup();
  log.collected(news(1, { title: 'OpenAI выпустила новую языковую модель' }));
  clock.tick(20 * 86400000);
  log.collected(news(2, { title: 'Сбер обновил GigaChat' }));
  const seen = log.seen(14);
  assert.deepStrictEqual(seen, [{ link: news(2).link, title: 'Сбер обновил GigaChat' }]);

  const { accepted, rejected } = filterItems(
    [
      { link: news(2).link + '?utm_medium=rss', title: 'Сбер обновил GigaChat' },
      { link: news(9).link, title: 'OpenAI выпустила новую языковую модель' },
    ],
    { keywords: ['GigaChat', 'OpenAI'] },
    seen
  );
  assert.strictEqual(rejected[0].reason, 'повтор ссылки');
  assert.strictEqual(accepted.length, 1);
});

test('журнал переживает повторный init', { skip }, () => {
  const { log } = setup();
  log.collected(news(1));
  log.init();
  assert.strictEqual(log.stats().total, 1);
});

test('причины отказа считаются по убыванию', { skip }, () => {
  const { log } = setup();
  for (let i = 1; i <= 4; i++) log.collected(news(i));
  log.rejected(news(1).link, 'стоп-слово');
  log.rejected(news(2).link, 'повтор ссылки');
  log.rejected(news(3).link, 'повтор ссылки');
  assert.deepStrictEqual(log.stats().reasons, [
    { reason: 'повтор ссылки', count: 2 },
    { reason: 'стоп-слово', count: 1 },
  ]);
});
