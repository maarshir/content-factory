// Сервис обложек: нужен npm ci --prefix cover, без зависимостей тесты пропускаются.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ready = fs.existsSync(path.join(__dirname, '..', 'cover', 'node_modules', 'sharp'));
const skip = ready ? false : 'нет зависимостей сервиса обложек (npm ci --prefix cover)';

test('обложка: JPEG 1280×720 с фото и без', { skip }, async () => {
  const sharp = require('../cover/node_modules/sharp');
  const { renderCover } = require('../cover/render.js');
  const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#d04020' } }).png().toBuffer();
  const a = await renderCover({ title: 'Открыта модель для русского языка', tag: 'модели', photo });
  const b = await renderCover({ title: 'Карточка без фото', tag: 'код' });
  for (const r of [a, b]) {
    const m = await sharp(r.image).metadata();
    assert.deepStrictEqual([m.format, m.width, m.height], ['jpeg', 1280, 720]);
  }
  assert.deepStrictEqual([a.photo, b.photo], [true, false]);
  // Нечитаемая картинка не роняет сервис: рисуется карточка.
  const c = await renderCover({ title: 'Битая картинка', photo: Buffer.from('не картинка') });
  assert.strictEqual(c.photo, false);
  await assert.rejects(renderCover({ title: '' }), /нет заголовка/);
});

test('обложка: длинный заголовок переносится и обрезается', { skip }, () => {
  const { fitTitle } = require('../cover/render.js');
  const short = fitTitle('Короткий заголовок', { sizes: [68, 50], maxWidth: 1136, maxLines: 3 });
  assert.deepStrictEqual([short.size, short.lines.length], [68, 1]);
  const long = fitTitle('слово '.repeat(60), { sizes: [68, 50], maxWidth: 1136, maxLines: 3 });
  assert.strictEqual(long.lines.length, 3);
  assert.match(long.lines[2], /…$/);
});

test('обложка: адреса внутренней сети не скачиваются', { skip }, async () => {
  const { privateIp, safeUrl } = require('../cover/server.js');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1']) {
    assert.strictEqual(privateIp(ip), true, ip);
  }
  assert.strictEqual(privateIp('93.184.216.34'), false);
  assert.strictEqual(await safeUrl('http://127.0.0.1:5678/'), null);
  assert.strictEqual(await safeUrl('file:///etc/passwd'), null);
  assert.strictEqual(await safeUrl('не адрес'), null);
});
