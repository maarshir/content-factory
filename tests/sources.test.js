const { test } = require('node:test');
const assert = require('node:assert');
const { sources, checked } = require('../src/sources.json');

test('у списка лент есть дата проверки', () => {
  assert.match(checked, /^\d{4}-\d{2}-\d{2}$/);
});

test('у каждой ленты имя, ссылка https и тип', () => {
  assert.ok(sources.length > 0);
  for (const s of sources) {
    assert.ok(s.name && s.name.trim(), 'имя');
    const u = new URL(s.url);
    assert.strictEqual(u.protocol, 'https:', s.url);
    assert.ok(['topic', 'general'].includes(s.kind), `${s.name}: kind`);
  }
});

test('ленты не повторяются', () => {
  const urls = sources.map((s) => s.url.toLowerCase().replace(/\/+$/, ''));
  assert.strictEqual(new Set(urls).size, urls.length);
});
