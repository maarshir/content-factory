// Узлы Code n8n 2.x выполняются в task runner без глобального URL.
// Разбор ссылок должен давать тот же результат и без него.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeUrl } = require('../src/filter.js');
const { buildPost, buildVkPost, buildMaxPost, parseLink } = require('../src/post.js');

function withoutUrl(fn) {
  const saved = globalThis.URL;
  delete globalThis.URL;
  try {
    return fn();
  } finally {
    globalThis.URL = saved;
  }
}

const LINKS = [
  'https://habr.com/ru/articles/1091582/?utm_campaign=1091582&utm_source=habrahabr&utm_medium=rss',
  'https://www.example.ru/news/42/?utm_source=tg&id=7#top',
  'http://example.ru/news/42?id=7',
  'https://a.ru/n?id=1',
  'https://a.ru/n?b=2&a=1&fbclid=x',
  'https://a.ru/поиск?q=нейросети+и+ии',
  'https://user@a.ru:8443/path/',
  'https://a.ru',
  ' Not A Url ',
  '',
];

test('normalizeUrl без URL совпадает с обычным', () => {
  const withUrl = LINKS.map(normalizeUrl);
  const without = withoutUrl(() => LINKS.map(normalizeUrl));
  assert.deepStrictEqual(without, withUrl);
});

test('normalizeUrl без URL убирает метки utm у ссылок Хабра', () => {
  const key = withoutUrl(() => normalizeUrl(LINKS[0]));
  assert.strictEqual(key, 'habr.com/ru/articles/1091582');
});

test('пост собирается без URL', () => {
  withoutUrl(() => {
    const fields = { title: 'Заголовок', text: 'Текст новости достаточной длины.', link: LINKS[0] };
    for (const build of [buildPost, buildVkPost, buildMaxPost]) {
      const p = build(fields);
      assert.ok(/Источник: (<a [^>]+>)?habr\.com/.test(p.text), p.text);
      assert.ok(p.text.includes('habr.com/ru/articles/1091582'), p.text);
    }
    const www = buildPost({ text: 'Текст новости', link: 'https://www.example.ru/n?a=1&b="2"' });
    assert.ok(www.text.includes('>example.ru</a>'), www.text);
    assert.ok(www.text.includes('&quot;2&quot;'), www.text);
  });
});

test('нечитаемая ссылка без URL отклоняется так же', () => {
  withoutUrl(() => {
    const text = 'Текст новости';
    assert.throws(() => buildPost({ text, link: '' }), /нет ссылки/);
    assert.throws(() => buildPost({ text, link: 'not a url' }), /нет ссылки/);
    assert.throws(() => buildPost({ text, link: 'https://' }), /нет ссылки/);
    assert.throws(() => buildPost({ text, link: 'https://exa mple.ru' }), /нет ссылки/);
    assert.throws(() => buildPost({ text, link: 'javascript:alert(1)' }), /http/);
    assert.throws(() => buildVkPost({ text, link: 'ftp://a.ru' }), /http/);
  });
});

test('parseLink с URL и без него даёт тот же протокол и хост', () => {
  for (const link of ['https://www.A.ru/x?y=1', 'http://a.ru:80/', 'ftp://a.ru/f']) {
    const a = parseLink(link);
    const b = withoutUrl(() => parseLink(link));
    assert.strictEqual(b.protocol, a.protocol);
    assert.strictEqual(b.hostname, a.hostname);
  }
});
