const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeUrl,
  findKeywords,
  titleSimilarity,
  filterItems,
} = require('../src/filter');
const config = require('../src/filter.config.json');

test('ссылки: метки utm, www, якорь и косая черта не делают статью новой', () => {
  const a = normalizeUrl('https://www.example.ru/news/42/?utm_source=tg&id=7#top');
  const b = normalizeUrl('http://example.ru/news/42?id=7');
  assert.strictEqual(a, b);
});

test('ссылки: разные параметры, кроме служебных, различаются', () => {
  assert.notStrictEqual(normalizeUrl('https://a.ru/n?id=1'), normalizeUrl('https://a.ru/n?id=2'));
});

test('ссылки: пустая и нечитаемая не роняют функцию', () => {
  assert.strictEqual(normalizeUrl(''), '');
  assert.strictEqual(normalizeUrl(undefined), '');
  assert.strictEqual(normalizeUrl(' Not A Url '), 'not a url');
});

test('ключевые слова: начало слова находит разные окончания', () => {
  assert.deepStrictEqual(findKeywords('Новые нейросетями пользуются чаще', ['нейросет']), ['нейросет']);
});

test('ключевые слова: короткое слово только целиком', () => {
  assert.deepStrictEqual(findKeywords('Компания ИИ-лаборатория', ['ИИ']), ['ИИ']);
  assert.deepStrictEqual(findKeywords('Сбербанк представил ИИСы', ['ИИ']), []);
});

test('ключевые слова: фраза ищется подряд, регистр и ё не важны', () => {
  assert.deepStrictEqual(findKeywords('Машинное обучение в банке', ['машинн обучени']), ['машинн обучени']);
  assert.deepStrictEqual(findKeywords('Обучение машинное', ['машинн обучени']), []);
  assert.deepStrictEqual(findKeywords('ЕЩЁ одна новость', ['еще']), ['еще']);
});

test('похожесть: одинаковые заголовки 1, разные около 0, пустые 0', () => {
  assert.strictEqual(titleSimilarity('OpenAI выпустила модель', 'OpenAI выпустила модель'), 1);
  assert.ok(titleSimilarity('OpenAI выпустила модель', 'Курс рубля вырос') < 0.1);
  assert.strictEqual(titleSimilarity('', 'что угодно'), 0);
});

test('похожесть: другие окончания и пунктуация почти не мешают', () => {
  const s = titleSimilarity(
    'Сбер представил новую версию GigaChat',
    'Сбер представила новые версии GigaChat!'
  );
  assert.ok(s >= 0.6, String(s));
});

test('отбор: принимает подходящее и объясняет каждый отказ', () => {
  const items = [
    { title: 'Anthropic выпустила новую модель Claude', link: 'https://a.ru/1' },
    { title: 'Курс рубля на сегодня', link: 'https://a.ru/2' },
    { title: 'Гороскоп от нейросети на неделю', link: 'https://a.ru/3' },
    { title: '', link: 'https://a.ru/4' },
    { title: 'Anthropic выпустила новую модель Claude', link: 'https://b.ru/1' },
    { title: 'Ещё раз про LLM', link: 'https://www.a.ru/1/?utm_medium=x' },
  ];
  const { accepted, rejected } = filterItems(items, config);
  assert.deepStrictEqual(accepted.map((i) => i.link), ['https://a.ru/1']);
  assert.deepStrictEqual(accepted[0].matched.sort(), ['Anthropic', 'Claude'].sort());
  assert.deepStrictEqual(
    rejected.map((r) => r.reason),
    ['нет ключевых слов', 'стоп-слово', 'нет заголовка', 'похожий заголовок', 'повтор ссылки']
  );
  assert.strictEqual(rejected[3].similarity, 1);
});

test('отбор: учитывает уже собранное раньше', () => {
  const seen = [{ title: 'Яндекс обновил YandexGPT', link: 'https://y.ru/a' }];
  const items = [
    { title: 'Яндекс обновил YandexGPT до пятой версии', link: 'https://z.ru/b' },
    { title: 'Новость про YandexGPT', link: 'https://y.ru/a?utm_source=rss' },
  ];
  const { accepted, rejected } = filterItems(items, config, seen);
  assert.strictEqual(accepted.length, 1);
  assert.strictEqual(rejected[0].reason, 'повтор ссылки');
});

test('отбор: порог похожести берётся из конфига', () => {
  const items = [
    { title: 'Сбер представил новую версию GigaChat', link: 'https://a.ru/1' },
    { title: 'Сбер показал GigaChat на конференции', link: 'https://a.ru/2' },
  ];
  const strict = filterItems(items, { ...config, similarityThreshold: 0.2 });
  const loose = filterItems(items, { ...config, similarityThreshold: 0.9 });
  assert.strictEqual(strict.accepted.length, 1);
  assert.strictEqual(loose.accepted.length, 2);
});

test('отбор: пустой список ключевых слов пропускает всё, пустой вход даёт пустой ответ', () => {
  const r = filterItems([{ title: 'Что угодно', link: 'x' }], { keywords: [] });
  assert.strictEqual(r.accepted.length, 1);
  assert.deepStrictEqual(filterItems([], config), { accepted: [], rejected: [] });
  assert.deepStrictEqual(filterItems(undefined, config), { accepted: [], rejected: [] });
});
