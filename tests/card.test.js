// Пост по частям для Телеграма: разбор ответа, сборка подписи, страница статьи, Телеграф.
const test = require('node:test');
const assert = require('node:assert');
const { parseCardResponse } = require('../src/parse.js');
const { buildCardPost, visibleLength, TELEGRAM_CAPTION_LIMIT } = require('../src/post.js');
const { parsePage, resolveUrl, decode } = require('../src/page.js');
const card = require('../src/card.js');

const ok = {
  relevance: 8, tag: 'Модели', emoji: '🧠 мозг', title: 'Открыта модель для русского языка.',
  lead: 'Открыта новая модель для русского языка, веса выложены.', points: ['- лицензия открытая', '', 'веса на сайте'], full: '',
};

test('разбор частей поста: рубрика, эмодзи, пункты чистятся', () => {
  const r = parseCardResponse('```json\n' + JSON.stringify(ok) + '\n```');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.card, {
    emoji: '🧠', tag: 'модели', title: 'Открыта модель для русского языка',
    lead: 'Открыта новая модель для русского языка, веса выложены.', points: ['лицензия открытая', 'веса на сайте'], full: '',
  });
  // Неизвестная рубрика и слово вместо эмодзи заменяются запасными.
  const x = parseCardResponse(JSON.stringify({ ...ok, tag: 'спорт', emoji: 'ракета' }));
  assert.deepStrictEqual([x.card.tag, x.card.emoji], ['события', '🧠']);
});

test('разбор частей поста: отказы', () => {
  assert.strictEqual(parseCardResponse('нет json').reason, 'ответ не JSON');
  assert.strictEqual(parseCardResponse(JSON.stringify({ ...ok, relevance: 3 })).reason, 'ниже порога релевантности');
  assert.strictEqual(parseCardResponse(JSON.stringify({ ...ok, title: '' })).reason, 'нет заголовка');
  assert.strictEqual(parseCardResponse(JSON.stringify({ ...ok, lead: 'коротко' })).reason, 'слишком короткая суть');
  assert.strictEqual(parseCardResponse(JSON.stringify({ ...ok, lead: 'Как языковая модель, я не могу помочь с этим.' })).reason, 'похоже на отказ модели');
  // При переписывании заголовок не нужен.
  assert.strictEqual(parseCardResponse(JSON.stringify({ ...ok, title: '' }), { title: false }).ok, true);
});

const base = {
  emoji: '🧠', tag: 'модели', title: 'Модель <A&B>', lead: 'Суть новости & подробности.',
  points: ['пункт один', 'пункт два'], link: 'https://habr.com/ru/1', sourceName: 'Хабр',
};

test('подпись: заголовок, суть, пункты в цитате, источник и хэштег', () => {
  const p = buildCardPost(base);
  assert.strictEqual(
    p.text,
    '🧠 <b>Модель &lt;A&amp;B&gt;</b>\n\nСуть новости &amp; подробности.\n\n' +
      '<blockquote>🔹 пункт один\n🔹 пункт два</blockquote>\n\n' +
      '🔗 Источник: <a href="https://habr.com/ru/1">Хабр</a>\n#модели'
  );
  assert.strictEqual(p.truncated, false);
  const more = buildCardPost({ ...base, telegraph: 'https://telegra.ph/x-10-13' });
  assert.match(more.text, /📖 <a href="https:\/\/telegra\.ph\/x-10-13">Читать подробнее<\/a> · 🔗 <a href="https:\/\/habr\.com\/ru\/1">Хабр<\/a>/);
  // Без пунктов цитаты нет.
  assert.doesNotMatch(buildCardPost({ ...base, points: [] }).text, /blockquote/);
});

test('подпись влезает в 1024 знака: сначала уходят пункты, потом обрезается суть', () => {
  const long = buildCardPost({ ...base, points: Array(4).fill('х'.repeat(180)) }, { limit: 600 });
  assert.ok(long.visibleLength <= 600);
  assert.strictEqual(long.truncated, true);
  const huge = buildCardPost({ ...base, lead: 'слово '.repeat(400), points: [] });
  assert.ok(huge.visibleLength <= TELEGRAM_CAPTION_LIMIT);
  assert.match(huge.text, /…\n\n🔗/);
  assert.strictEqual(visibleLength('<b>a&amp;b</b>'), 3);
  assert.throws(() => buildCardPost({ ...base, title: '' }), /нет заголовка/);
  assert.throws(() => buildCardPost({ ...base, link: '' }), /нет ссылки/);
});

test('страница статьи: картинка og:image и текст без меню', () => {
  const html = `<html><head>
    <meta name="twitter:image" content="https://cdn.example.com/t.jpg">
    <meta content="//cdn.example.com/og.webp?a=1&amp;b=2" property="og:image">
    </head><body><header><p>Шапка сайта с длинным меню и ссылками на разделы</p></header>
    <article><h2>Что нового</h2><p>Первый абзац статьи достаточно длинный, чтобы попасть в текст пересказа.</p>
    <p>Коротко</p><ul><li>Пункт списка тоже попадает в текст, если он длинный и по делу.</li></ul>
    <script>var x = '<p>не текст статьи, а код страницы</p>';</script>
    <p>Подпишитесь на наш канал, чтобы не пропустить новые материалы сайта.</p></article>
    <footer><p>Все права защищены, перепечатка запрещена без согласия редакции.</p></footer></body></html>`;
  const page = parsePage(html, 'https://example.com/news/1');
  assert.strictEqual(page.image, 'https://cdn.example.com/og.webp?a=1&b=2');
  assert.strictEqual(
    page.text,
    'Что нового\n\nПервый абзац статьи достаточно длинный, чтобы попасть в текст пересказа.\n\nПункт списка тоже попадает в текст, если он длинный и по делу.'
  );
  assert.deepStrictEqual(parsePage('', 'https://example.com'), { image: '', text: '' });
  assert.deepStrictEqual(parsePage({ error: 1 }, 'https://example.com'), { image: '', text: '' });
  assert.strictEqual(parsePage('<html><meta property="og:image" content="/logo.svg"></html>', 'https://e.com/a').image, '');
});

test('адреса картинок и сущности', () => {
  assert.strictEqual(resolveUrl('/i.jpg', 'https://e.com/a/b'), 'https://e.com/i.jpg');
  assert.strictEqual(resolveUrl('i.jpg', 'https://e.com/a/b'), 'https://e.com/a/i.jpg');
  assert.strictEqual(resolveUrl('data:image/png;base64,xx', 'https://e.com'), '');
  assert.strictEqual(decode('&laquo;ИИ&raquo; &#8212; &#x41;&nbsp;'), '«ИИ» — A ');
});

test('Телеграф: страница только у большой новости, ответ с адресом', () => {
  const full = 'Абзац пересказа. '.repeat(50);
  assert.strictEqual(card.needFull({ full }, 'x'.repeat(2000)), true);
  assert.strictEqual(card.needFull({ full }, 'x'.repeat(500)), false);
  assert.strictEqual(card.needFull({ full: 'коротко' }, 'x'.repeat(2000)), false);
  const req = card.telegraphPage({ title: 'Т', full: 'Первый.\n\nВторой.', image: 'https://e.com/i.jpg', link: 'https://e.com/a', sourceName: 'Пример' });
  const content = JSON.parse(req.content);
  assert.deepStrictEqual(content.map((n) => n.tag), ['figure', 'p', 'p', 'p', 'p']);
  assert.deepStrictEqual(content[1].children, ['Первый.']);
  assert.strictEqual(req.author_url, 'https://t.me/neiro_glav');
  assert.ok(!('access_token' in req));
  assert.strictEqual(card.telegraphUrl({ ok: true, result: { url: 'https://telegra.ph/T-10-13' } }), 'https://telegra.ph/T-10-13');
  assert.strictEqual(card.telegraphUrl({ ok: false, error: 'ACCESS_TOKEN_INVALID' }), '');
  assert.strictEqual(card.telegraphUrl({ ok: true, result: { url: 'https://evil.example/x' } }), '');
});

test('канал из настроек, части поста в журнале', () => {
  assert.deepStrictEqual(card.channelOf({}), { name: 'Нейросети: главное за день', url: 'https://t.me/neiro_glav', handle: '@neiro_glav' });
  assert.strictEqual(card.channelOf({ CHANNEL_URL: 'https://t.me/other_ch' }).handle, '@other_ch');
  const stored = card.storeCard({ ...base, full: 'длинный текст', image: 'https://e.com/i.jpg', telegraph: '' });
  assert.ok(!stored.includes('длинный текст'));
  assert.strictEqual(card.readCard(stored).title, base.title);
  assert.strictEqual(card.readCard('не json'), null);
  assert.strictEqual(card.readCard(null), null);
});
