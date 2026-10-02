const { test } = require('node:test');
const assert = require('node:assert');
const { createLog } = require('../src/log.js');
const { createQueue, checkPublishConfig, inQuietHours } = require('../src/queue.js');
const config = require('../src/publish.config.json');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {}
const skip = DatabaseSync ? false : 'нет node:sqlite (нужен Node 22.5+)';

// 07:00 UTC = 10:00 по Москве, вне тихих часов.
function setup(start = '2026-10-01T07:00:00Z') {
  let t = Date.parse(start);
  const clock = { tick: (min) => (t += min * 60000), set: (iso) => (t = Date.parse(iso)) };
  const db = new DatabaseSync(':memory:');
  const log = createLog(db, { now: () => new Date(t).toISOString() });
  log.init();
  const queue = createQueue(db, { now: () => new Date(t).toISOString() });
  queue.init();
  return { db, log, queue, clock };
}

const link = (n) => `https://example.com/news/${n}`;
function enqueue(log, clock, n) {
  log.collected({ link: link(n), title: `Новость ${n}` });
  log.drafted(link(n), `<b>Новость ${n}</b>`);
  log.queued(link(n));
  clock.tick(1);
}

const cfg = { minIntervalMinutes: 60, quietHours: { from: '23:00', to: '08:00' }, timeZone: 'Europe/Moscow', maxAttempts: 3 };

test('настройки публикации проверяются', () => {
  assert.deepStrictEqual(checkPublishConfig(config).quietHours, { from: 23 * 60, to: 8 * 60 });
  assert.strictEqual(checkPublishConfig({}).minIntervalMinutes, 60);
  assert.strictEqual(checkPublishConfig({}).quietHours, null);
  assert.throws(() => checkPublishConfig({ quietHours: { from: '25:00', to: '08:00' } }), /ЧЧ:ММ/);
  assert.throws(() => checkPublishConfig({ minIntervalMinutes: -1 }), /minIntervalMinutes/);
  assert.throws(() => checkPublishConfig({ maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => checkPublishConfig({ timeZone: 'Нигде/Никогда' }));
});

test('тихие часы через полночь и внутри дня, по местному времени', () => {
  const night = { from: 23 * 60, to: 8 * 60 };
  const msk = (iso) => inQuietHours(Date.parse(iso), night, 'Europe/Moscow');
  assert.strictEqual(msk('2026-10-01T20:00:00Z'), true); // 23:00 МСК
  assert.strictEqual(msk('2026-10-01T23:30:00Z'), true); // 02:30 МСК
  assert.strictEqual(msk('2026-10-02T04:59:00Z'), true); // 07:59 МСК
  assert.strictEqual(msk('2026-10-02T05:00:00Z'), false); // 08:00 МСК
  assert.strictEqual(msk('2026-10-01T19:59:00Z'), false); // 22:59 МСК
  const day = { from: 13 * 60, to: 14 * 60 };
  assert.strictEqual(inQuietHours(Date.parse('2026-10-01T13:30:00Z'), day, 'UTC'), true);
  assert.strictEqual(inQuietHours(Date.parse('2026-10-01T14:00:00Z'), day, 'UTC'), false);
  assert.strictEqual(inQuietHours(Date.parse('2026-10-01T13:30:00Z'), { from: 600, to: 600 }, 'UTC'), false);
});

test('очередь: первым идёт поставленный раньше, пустая очередь', { skip }, () => {
  const { log, queue, clock } = setup();
  assert.deepStrictEqual(queue.next(cfg), { item: null, wait: 'empty' });
  enqueue(log, clock, 2);
  enqueue(log, clock, 1);
  // Черновик без очереди не публикуется.
  log.collected({ link: link(3), title: 'Новость 3' });
  log.drafted(link(3), 'текст');
  const r = queue.next(cfg);
  assert.strictEqual(r.wait, null);
  assert.strictEqual(r.item.link, link(2));
});

test('интервал после прошлой публикации', { skip }, () => {
  const { log, queue, clock } = setup();
  enqueue(log, clock, 1);
  enqueue(log, clock, 2);
  log.published(link(1), 101);
  clock.tick(59);
  assert.deepStrictEqual(queue.next(cfg), { item: null, wait: 'interval' });
  clock.tick(1);
  assert.strictEqual(queue.next(cfg).item.link, link(2));
  assert.strictEqual(queue.next({ ...cfg, minIntervalMinutes: 0 }).item.link, link(2));
});

test('в тихие часы пост ждёт', { skip }, () => {
  const { log, queue, clock } = setup('2026-10-01T21:00:00Z'); // 00:00 МСК
  enqueue(log, clock, 1);
  assert.deepStrictEqual(queue.next(cfg), { item: null, wait: 'quiet' });
  assert.strictEqual(queue.next({ ...cfg, quietHours: null }).item.link, link(1));
  clock.set('2026-10-02T05:00:00Z'); // 08:00 МСК
  assert.strictEqual(queue.next(cfg).item.link, link(1));
});

test('ошибка Телеграма: пост остаётся в очереди, после maxAttempts пропускается', { skip }, () => {
  const { log, queue, clock } = setup();
  enqueue(log, clock, 1);
  enqueue(log, clock, 2);
  const id = log.get(link(1)).id;
  let row = queue.failed(id, 'Bad Request: chat not found');
  assert.strictEqual(row.status, 'queued');
  assert.strictEqual(row.attempts, 1);
  assert.strictEqual(row.reason, 'ошибка Телеграма: Bad Request: chat not found');
  assert.strictEqual(queue.next(cfg).item.link, link(1));
  assert.strictEqual(queue.failed(id, '').reason, 'ошибка Телеграма: неизвестная ошибка');
  row = queue.failed(id, 'timeout');
  assert.strictEqual(row.attempts, 3);
  assert.strictEqual(queue.next(cfg).item.link, link(2));
  assert.strictEqual(log.stats().queued, 2);
  // Опубликованный после ошибок пост теряет текст ошибки.
  row = queue.published(id, 7);
  assert.strictEqual(row.status, 'published');
  assert.strictEqual(row.message_id, '7');
  assert.strictEqual(row.reason, null);
  assert.ok(row.published_at);
  assert.throws(() => queue.failed(id, 'x'), /только для queued/);
  assert.throws(() => queue.published(id, 8), /только из queued/);
  assert.throws(() => queue.published(log.get(link(2)).id, ''), /нет номера/);
  assert.throws(() => queue.failed(999, 'x'), /нет в журнале/);
});

test('журнал без счётчика попыток получает его при init()', { skip }, () => {
  const db = new DatabaseSync(':memory:');
  const queue = createQueue(db);
  assert.throws(() => queue.init(), /log\.init/);
  const log = createLog(db, { now: () => '2026-10-01T07:00:00.000Z' });
  log.init();
  log.collected({ link: link(1), title: 'Новость 1' });
  queue.init();
  queue.init();
  assert.strictEqual(log.get(link(1)).attempts, 0);
  // Журнал с новым столбцом читается log.js как раньше.
  log.init();
  assert.strictEqual(log.stats().collected, 1);
});
