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
