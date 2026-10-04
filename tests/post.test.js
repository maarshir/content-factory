const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { escapeHtml, truncate, buildPost, fillPrompt, TELEGRAM_TEXT_LIMIT } = require('../src/post');

const visible = (html) =>
  html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

test('экранирование: &, < и > в тексте и заголовке', () => {
  assert.strictEqual(escapeHtml('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d');
  const p = buildPost({ title: 'Модель <X>', text: 'Тег <script> и R&D отдел, текст длиннее двадцати знаков.', link: 'https://a.ru/1' });
  assert.ok(p.text.includes('<b>Модель &lt;X&gt;</b>'));
  assert.ok(p.text.includes('&lt;script&gt; и R&amp;D'));
  assert.ok(!p.text.includes('<script>'));
});

test('ссылка на источник обязательна и экранируется в атрибуте', () => {
  assert.throws(() => buildPost({ title: 'T', text: 'Текст новости', link: '' }), /источник/);
  assert.throws(() => buildPost({ title: 'T', text: 'Текст новости', link: 'not a url' }), /источник/);
  assert.throws(() => buildPost({ title: 'T', text: 'Текст новости', link: 'javascript:alert(1)' }), /http/);
  const p = buildPost({ text: 'Текст новости', link: 'https://www.example.ru/n?a=1&b="2"' });
  assert.ok(p.text.endsWith('Источник: <a href="https://www.example.ru/n?a=1&amp;b=%222%22">example.ru</a>'));
});

test('пустой текст не превращается в пост', () => {
  assert.throws(() => buildPost({ title: 'T', text: '   ', link: 'https://a.ru' }), /пустой/);
});

test('длинный текст обрезается до лимита Телеграма по видимым знакам', () => {
  const text = 'Предложение номер раз & ещё <немного>. '.repeat(300);
  const p = buildPost({ title: 'Заголовок', text, link: 'https://a.ru/1' });
  assert.ok(p.truncated);
  assert.ok(p.visibleLength <= TELEGRAM_TEXT_LIMIT);
  assert.strictEqual(visible(p.text).length, p.visibleLength);
});

test('короткий текст не обрезается, длина считается верно', () => {
  const p = buildPost({ title: 'A&B', text: 'Коротко <и> ясно, но достаточно.', link: 'https://a.ru/1', sourceName: 'Хабр' });
  assert.strictEqual(p.truncated, false);
  assert.strictEqual(visible(p.text).length, p.visibleLength);
  assert.ok(p.text.includes('>Хабр</a>'));
});

test('подпись к картинке ограничена 1024 знаками', () => {
  const p = buildPost({ title: 'T', text: 'слово '.repeat(500), link: 'https://a.ru' }, { caption: true });
  assert.ok(p.visibleLength <= 1024);
});

test('обрезка: по предложению, иначе по слову с многоточием', () => {
  assert.strictEqual(truncate('Первое предложение тут. Второе длинное предложение', 30), 'Первое предложение тут.');
  assert.strictEqual(truncate('одно два три четыре пять', 15), 'одно два три…');
  assert.strictEqual(truncate('коротко', 100), 'коротко');
});

test('обрезка не рвёт суррогатную пару', () => {
  const s = 'a'.repeat(8) + '😀😀😀';
  const t = truncate(s, 10);
  assert.ok(t.length <= 10);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t));
});

test('промпт: подстановка полей, неизвестные остаются видимыми', () => {
  assert.strictEqual(fillPrompt('{{title}} / {{ link }} / {{x}}', { title: 'T', link: 'L' }), 'T / L / {{x}}');
});

test('промпт Телеграма: все поля подставляются, просит JSON', () => {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'telegram.md'), 'utf8');
  const filled = fillPrompt(tpl, { title: 'T', description: 'D', link: 'https://a.ru', maxLength: 900 });
  assert.ok(!/\{\{\s*\w+\s*\}\}/.test(filled));
  assert.ok(filled.includes('"relevance"') && filled.includes('"text"'));
});

const { buildVkPost, buildPostFor, platformOf, VK_TEXT_LIMIT } = require('../src/post');

test('ВКонтакте: простой текст без HTML, ссылка последней строкой', () => {
  const p = buildVkPost({ title: 'Модель <X> & R&D', text: 'Первый абзац.\r\n\r\n\r\n\r\nВторой абзац с <тегом>.', link: 'https://www.a.ru/n?a=1&b=2' });
  assert.strictEqual(
    p.text,
    'Модель <X> & R&D\n\nПервый абзац.\n\nВторой абзац с <тегом>.\n\nИсточник: a.ru\nhttps://www.a.ru/n?a=1&b=2'
  );
  assert.ok(!('parse_mode' in p));
  assert.strictEqual(p.visibleLength, p.text.length);
  assert.strictEqual(p.truncated, false);
});

test('ВКонтакте: без заголовка, своё имя источника', () => {
  const p = buildVkPost({ text: 'Текст новости достаточной длины.', link: 'https://habr.com/1', sourceName: 'Хабр' });
  assert.ok(p.text.startsWith('Текст новости'));
  assert.ok(p.text.endsWith('\n\nИсточник: Хабр\nhttps://habr.com/1'));
});

test('ВКонтакте: ссылка обязательна, пустой текст не пост', () => {
  assert.throws(() => buildVkPost({ text: 'Текст новости', link: '' }), /источник/);
  assert.throws(() => buildVkPost({ text: 'Текст новости', link: 'ftp://a.ru' }), /http/);
  assert.throws(() => buildVkPost({ text: ' \n ', link: 'https://a.ru' }), /пустой/);
});

test('ВКонтакте: длинный текст обрезается до предела, ссылка остаётся', () => {
  const p = buildVkPost({ title: 'Заголовок', text: 'Предложение номер раз. '.repeat(400), link: 'https://a.ru/1' });
  assert.ok(p.truncated);
  assert.ok(p.text.length <= VK_TEXT_LIMIT);
  assert.ok(p.text.endsWith('https://a.ru/1'));
  const small = buildVkPost({ text: 'слово '.repeat(100), link: 'https://a.ru/1' }, { limit: 200 });
  assert.ok(small.text.length <= 200);
});

test('площадка из «Настроек»: по умолчанию telegram, неизвестная с ошибкой', () => {
  assert.strictEqual(platformOf({}), 'telegram');
  assert.strictEqual(platformOf({ PLATFORM: '' }), 'telegram');
  assert.strictEqual(platformOf({ PLATFORM: ' VK ' }), 'vk');
  assert.throws(() => platformOf({ PLATFORM: 'max' }), /неизвестная площадка/);
});

test('сборка по площадке', () => {
  const fields = { title: 'A&B', text: 'Текст новости достаточной длины.', link: 'https://a.ru/1' };
  assert.strictEqual(buildPostFor('telegram', fields).parse_mode, 'HTML');
  assert.ok(buildPostFor('vk', fields).text.startsWith('A&B\n\n'));
  assert.throws(() => buildPostFor('max', fields), /неизвестная площадка/);
});

test('промпт ВКонтакте: все поля подставляются, тот же формат JSON', () => {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'vk.md'), 'utf8');
  const filled = fillPrompt(tpl, { title: 'T', description: 'D', link: 'https://a.ru', maxLength: 900 });
  assert.ok(!/\{\{\s*\w+\s*\}\}/.test(filled));
  assert.ok(filled.includes('"relevance"') && filled.includes('"text"'));
});
