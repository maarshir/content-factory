const { test } = require('node:test');
const assert = require('node:assert');
const { buildPost } = require('../src/post');
const { htmlToPlain } = require('../src/plain');

test('htmlToPlain: черновик Телеграма в простой текст для ВКонтакте', () => {
  const html = buildPost({ title: 'A < B & C', text: 'Текст "в кавычках".', link: 'https://example.com/a?x=1&y=2' }).text;
  assert.strictEqual(
    htmlToPlain(html),
    'A < B & C\n\nТекст "в кавычках".\n\nИсточник: example.com\nhttps://example.com/a?x=1&y=2'
  );
  // Текст без тегов не меняется, &amp; в нём не трогается.
  assert.strictEqual(htmlToPlain(' Простой &amp; текст '), 'Простой &amp; текст');
  assert.strictEqual(htmlToPlain(null), '');
});
