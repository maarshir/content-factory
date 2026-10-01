const { test } = require('node:test');
const assert = require('node:assert');
const { extractJson, parseModelResponse } = require('../src/parse');

const good = 'OpenAI выпустила новую открытую модель для распознавания речи. Она работает на обычном ноутбуке.';

test('чистый JSON разбирается', () => {
  const r = parseModelResponse(JSON.stringify({ relevance: 8, text: good }));
  assert.deepStrictEqual(r, { ok: true, relevance: 8, text: good, reason: null });
});

test('JSON в блоке кода и с пояснениями вокруг', () => {
  const raw = 'Вот ответ:\n```json\n' + JSON.stringify({ relevance: '7,5', text: good }) + '\n```\nНадеюсь, помог!';
  const r = parseModelResponse(raw);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.relevance, 7.5);
});

test('фигурные скобки и кавычки внутри строки не ломают разбор', () => {
  const obj = { relevance: 9, text: 'Функция {x} и "кавычки" } в тексте, достаточно длинном для поста.' };
  assert.deepStrictEqual(extractJson('пролог ' + JSON.stringify(obj) + ' {мусор'), obj);
});

test('не JSON, массив, оборванный JSON', () => {
  assert.strictEqual(parseModelResponse('Новость интересная, 8 из 10').reason, 'ответ не JSON');
  assert.strictEqual(parseModelResponse('[1,2]').reason, 'ответ не JSON');
  assert.strictEqual(parseModelResponse('{"relevance": 8, "text": "обрыв').reason, 'ответ не JSON');
  assert.strictEqual(parseModelResponse(undefined).reason, 'ответ не JSON');
});

test('оценка вне шкалы или не число', () => {
  for (const relevance of [11, -1, 'высокая', null, NaN]) {
    assert.strictEqual(parseModelResponse(JSON.stringify({ relevance, text: good })).reason, 'оценка вне шкалы 0–10');
  }
});

test('ниже порога отклоняется, порог настраивается', () => {
  const raw = JSON.stringify({ relevance: 5, text: good });
  assert.strictEqual(parseModelResponse(raw).reason, 'ниже порога релевантности');
  assert.strictEqual(parseModelResponse(raw, { minRelevance: 5 }).ok, true);
});

test('пустой, короткий и длинный текст', () => {
  assert.strictEqual(parseModelResponse('{"relevance": 9}').reason, 'нет текста');
  assert.strictEqual(parseModelResponse('{"relevance": 9, "text": "  "}').reason, 'пустой текст');
  assert.strictEqual(parseModelResponse('{"relevance": 9, "text": "Коротко."}').reason, 'слишком короткий текст');
  const long = JSON.stringify({ relevance: 9, text: 'а'.repeat(4000) });
  assert.strictEqual(parseModelResponse(long).reason, 'слишком длинный текст');
});

test('отказ модели и неподставленный шаблон считаются мусором', () => {
  for (const text of [
    'Как языковая модель, я не могу оценивать новости, но могу помочь иначе.',
    "I'm sorry, but I cannot rewrite this article for you right now.",
    'Новость: {{title}}. Подробности по ссылке в источнике, читайте полностью.',
  ]) {
    assert.strictEqual(parseModelResponse(JSON.stringify({ relevance: 9, text })).reason, 'похоже на отказ модели');
  }
});

test('лишние пустые строки и \\r\\n нормализуются', () => {
  const r = parseModelResponse(JSON.stringify({ relevance: 8, text: 'Абзац один достаточно длинный.\r\n\r\n\r\n\r\nАбзац два тоже.' }));
  assert.strictEqual(r.text, 'Абзац один достаточно длинный.\n\nАбзац два тоже.');
});
