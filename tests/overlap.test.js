const { test } = require('node:test');
const assert = require('node:assert');
const { words, overlap, overlapNote, DEFAULT_MAX } = require('../src/overlap.js');

// Синтетическое описание из ленты.
const SOURCE =
  'Компания выложила в открытый доступ языковую модель для русского языка. ' +
  'Веса модели можно скачать бесплатно, код обучения опубликован на Гитхабе под лицензией MIT.';

test('слова: нижний регистр, ё как е, без разметки и знаков', () => {
  assert.deepStrictEqual(words('<b>Ещё</b> «Модель»-2, ЁЛКА!'), ['еще', 'модель', '2', 'елка']);
  assert.deepStrictEqual(words(''), []);
  assert.deepStrictEqual(words(null), []);
});

test('пересказ своими словами почти не совпадает', () => {
  const post = 'Открыта новая модель для русского: веса бесплатны, а обучающий код лежит на Гитхабе.';
  const r = overlap(post, SOURCE);
  assert.strictEqual(r.matched, 0);
  assert.strictEqual(r.ratio, 0);
  assert.strictEqual(overlapNote(r), '');
});

test('скопированное предложение даёт большую долю и фрагмент', () => {
  const post = 'Новость дня. Веса модели можно скачать бесплатно, код обучения опубликован на Гитхабе.';
  const r = overlap(post, SOURCE);
  assert.ok(r.ratio > 0.5, String(r.ratio));
  assert.strictEqual(r.fragment, 'веса модели можно скачать бесплатно код обучения опубликован на гитхабе');
  const note = overlapNote(r);
  assert.match(note, /^Дословно из источника: \d+% \(порог 20%\), например «веса модели/);
});

test('полная копия: доля 1, длина цепочки настраивается', () => {
  assert.strictEqual(overlap(SOURCE, SOURCE).ratio, 1);
  const post = 'Модель для русского языка вышла, веса можно скачать.';
  assert.strictEqual(overlap(post, SOURCE, { words: 5 }).matched, 0);
  assert.ok(overlap(post, SOURCE, { words: 3 }).matched > 0);
});

test('короткие тексты и пустой источник не дают ложных пометок', () => {
  assert.deepStrictEqual(overlap('Три слова тут', SOURCE), { ratio: 0, matched: 0, total: 0, fragment: '' });
  assert.strictEqual(overlap(SOURCE, '').ratio, 0);
  assert.strictEqual(overlap(SOURCE, undefined).ratio, 0);
  assert.strictEqual(overlapNote({ ratio: 0, matched: 0, total: 0, fragment: '' }), '');
});

test('порог: равная доля не помечается, свой порог из настроек', () => {
  const r = { ratio: DEFAULT_MAX, matched: 1, total: 5, fragment: 'а б в г д' };
  assert.strictEqual(overlapNote(r), '');
  assert.match(overlapNote(r, { max: 0.1 }), /порог 10%/);
  assert.strictEqual(overlapNote(r, { max: '' }), '');
  assert.strictEqual(overlapNote(r, { max: 0.5 }), '');
});

test('длинный фрагмент обрезается', () => {
  const r = { ratio: 1, matched: 30, total: 30, fragment: 'слово '.repeat(30).trim() };
  const m = overlapNote(r).match(/«(.*)»$/);
  assert.ok(m[1].length <= 60);
  assert.ok(m[1].endsWith('…'));
});
