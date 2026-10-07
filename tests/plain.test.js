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

const { buildVkPost } = require('../src/post');
const { isTelegramPost, textFor } = require('../src/plain');

test('isTelegramPost: площадка черновика по тексту', () => {
  const tg = buildPost({ title: 'Заголовок', text: 'Текст.', link: 'https://example.com/a' }).text;
  const vk = buildVkPost({ title: 'Заголовок', text: 'Сравнение 2 < 3 & 4 > 1.', link: 'https://example.com/a' }).text;
  assert.strictEqual(isTelegramPost(tg), true);
  assert.strictEqual(isTelegramPost(vk), false);
  assert.strictEqual(isTelegramPost(null), false);
});

test('textFor: перевод только для черновиков другой площадки', () => {
  const tg = buildPost({ title: 'A & B', text: 'Текст.', link: 'https://example.com/a' }).text;
  const vk = buildVkPost({ title: 'A & B', text: 'Текст про <тег>.', link: 'https://example.com/a' }).text;
  // Черновик Телеграма: для ВКонтакте простой текст, для Телеграма без изменений.
  assert.strictEqual(textFor('vk', tg), 'A & B\n\nТекст.\n\nИсточник: example.com\nhttps://example.com/a');
  assert.strictEqual(textFor('telegram', tg), tg);
  // Пост ВКонтакте: на стену как есть (угловые скобки в тексте не теги), в Телеграм экранируется.
  assert.strictEqual(textFor('vk', vk), vk);
  assert.strictEqual(textFor('telegram', vk), vk.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
});
