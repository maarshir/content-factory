// Обложка поста 1280×720 в стиле канала: фото из статьи под тёмной вуалью
// с неоновой плашкой (рубрика, заголовок, подпись канала). Без фото рисуется
// фирменная карточка на тёмном фоне. Наружу отдаётся JPEG.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const sharp = require('sharp');
const opentype = require('opentype.js');

const W = 1280;
const H = 720;
const PAD = 72;

const FONT_DIR = path.join(__dirname, 'fonts');
const FONTS = {
  title: path.join(FONT_DIR, 'InterDisplay-ExtraBold.ttf'),
  text: path.join(FONT_DIR, 'Inter-Medium.ttf'),
  mono: path.join(FONT_DIR, 'JetBrainsMono-Bold.ttf'),
};
const titleFont = opentype.parse(fs.readFileSync(FONTS.title).buffer);
const monoFont = opentype.parse(fs.readFileSync(FONTS.mono).buffer);

// Цвета канала: неоновый голубой на почти чёрном синем.
const STYLE = {
  neon: '#22D3FF',
  neonSoft: '#8BEBFF',
  deep: '#030814',
  ink: '#F2FBFF',
  muted: '#B9DCEB',
};

const DEFAULTS = {
  channel: 'Нейросети: главное за день',
  handle: '@neiro_glav',
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Ширина строки по ширинам знаков шрифта, без кернинга: чуть с запасом.
function width(font, text, size, spacing = 0) {
  const chars = [...String(text)];
  const units = chars.reduce((sum, c) => sum + (font.charToGlyph(c).advanceWidth || 0), 0);
  return (units * size) / font.unitsPerEm + spacing * Math.max(0, chars.length - 1);
}

// Перенос заголовка по словам в maxWidth. Не влезло в maxLines строк:
// последняя строка обрезается по слову с многоточием.
function wrap(text, size, maxWidth, maxLines) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  let i = 0;
  for (; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (width(titleFont, next, size) <= maxWidth || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = words[i];
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) {
    lines.push(line);
    i = words.length;
  }
  const fits = i >= words.length && lines.every((l) => width(titleFont, l, size) <= maxWidth);
  if (!fits) {
    let last = lines[lines.length - 1] || '';
    while (last && width(titleFont, last + '…', size) > maxWidth) last = last.replace(/\s*\S+$/, '');
    lines[lines.length - 1] = (last || '').replace(/[\s,;:.\-]+$/, '') + '…';
  }
  return { lines, fits };
}

// Самый крупный кегль, при котором заголовок целиком влезает в строки.
function fitTitle(title, { sizes, maxWidth, maxLines }) {
  for (const size of sizes) {
    const r = wrap(title, size, maxWidth, maxLines);
    if (r.fits) return { size, lines: r.lines };
  }
  const size = sizes[sizes.length - 1];
  return { size, lines: wrap(title, size, maxWidth, maxLines).lines };
}

const DEFS = `
  <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="6" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="soft" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="3" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <linearGradient id="veil" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${STYLE.deep}" stop-opacity="0.55"/>
    <stop offset="0.35" stop-color="${STYLE.deep}" stop-opacity="0.15"/>
    <stop offset="0.6" stop-color="${STYLE.deep}" stop-opacity="0.55"/>
    <stop offset="1" stop-color="${STYLE.deep}" stop-opacity="0.96"/>
  </linearGradient>
  <linearGradient id="side" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="${STYLE.deep}" stop-opacity="0.6"/>
    <stop offset="0.7" stop-color="${STYLE.deep}" stop-opacity="0"/>
  </linearGradient>
  <radialGradient id="blobA" cx="0.85" cy="0.15" r="0.6">
    <stop offset="0" stop-color="#1E7BFF" stop-opacity="0.55"/>
    <stop offset="1" stop-color="#1E7BFF" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="blobB" cx="0.1" cy="0.95" r="0.55">
    <stop offset="0" stop-color="${STYLE.neon}" stop-opacity="0.35"/>
    <stop offset="1" stop-color="${STYLE.neon}" stop-opacity="0"/>
  </radialGradient>
  <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
    <path d="M48 0H0V48" fill="none" stroke="${STYLE.neon}" stroke-opacity="0.08" stroke-width="1"/>
  </pattern>`;

// Уголки рамки: техничнее сплошной рамки и не спорят с фото.
function corners() {
  const m = 28;
  const l = 44;
  const d = [
    `M${m} ${m + l}V${m}H${m + l}`,
    `M${W - m - l} ${m}H${W - m}V${m + l}`,
    `M${m} ${H - m - l}V${H - m}H${m + l}`,
    `M${W - m - l} ${H - m}H${W - m}V${H - m - l}`,
  ].join('');
  return `<path d="${d}" fill="none" stroke="${STYLE.neon}" stroke-width="3" stroke-opacity="0.9" filter="url(#soft)"/>`;
}

function tagPill(tag) {
  const text = String(tag || '').trim().toUpperCase();
  if (!text) return '';
  const size = 24;
  const spacing = 3;
  const w = Math.round(width(monoFont, text, size, spacing) + 40);
  const x = PAD;
  const y = 64;
  return `
  <rect x="${x}" y="${y}" width="${w}" height="46" rx="23" fill="${STYLE.deep}" fill-opacity="0.55"
        stroke="${STYLE.neon}" stroke-width="2" filter="url(#glow)"/>
  <text x="${x + 20}" y="${y + 31}" font-family="JetBrains Mono" font-weight="700" font-size="${size}"
        letter-spacing="${spacing}" fill="${STYLE.neonSoft}">${esc(text)}</text>`;
}

function channelMark(channel) {
  const size = 24;
  const right = W - PAD;
  return `
  <circle cx="${right - 6}" cy="87" r="6" fill="${STYLE.neon}" filter="url(#glow)"/>
  <text x="${right - 24}" y="95" text-anchor="end" font-family="Inter" font-weight="500" font-size="${size}"
        fill="${STYLE.muted}">${esc(channel)}</text>`;
}

function titleBlock(title, { photo }) {
  // На карточке справа узор, заголовок занимает левую часть.
  const maxWidth = photo ? W - PAD * 2 : 860;
  const { size, lines } = fitTitle(title, {
    sizes: photo ? [68, 62, 56, 50, 46] : [72, 64, 58, 52, 46],
    maxWidth,
    maxLines: photo ? 3 : 4,
  });
  const lead = Math.round(size * 1.12);
  const bottom = H - 96;
  const top = bottom - lead * (lines.length - 1);
  const bar = top - size - 18;
  const tspans = lines
    .map((l, i) => `<tspan x="${PAD}" y="${top + i * lead}">${esc(l)}</tspan>`)
    .join('');
  return `
  <rect x="${PAD}" y="${bar}" width="120" height="6" rx="3" fill="${STYLE.neon}" filter="url(#glow)"/>
  <text font-family="Inter Display" font-weight="800" font-size="${size}" fill="${STYLE.ink}">${tspans}</text>`;
}

function handleMark(handle) {
  if (!handle) return '';
  return `<text x="${W - PAD}" y="${H - 52}" text-anchor="end" font-family="JetBrains Mono" font-weight="700"
        font-size="22" fill="${STYLE.neon}" filter="url(#soft)">${esc(handle)}</text>`;
}

// Слой поверх фото (прозрачный фон) или вся карточка без фото.
function coverSvg({ title, tag, channel, handle, photo }) {
  const back = photo
    ? `<rect width="${W}" height="${H}" fill="url(#veil)"/><rect width="${W}" height="${H}" fill="url(#side)"/>`
    : `<rect width="${W}" height="${H}" fill="${STYLE.deep}"/>
       <rect width="${W}" height="${H}" fill="url(#grid)"/>
       <rect width="${W}" height="${H}" fill="url(#blobA)"/>
       <rect width="${W}" height="${H}" fill="url(#blobB)"/>
       <circle cx="1060" cy="330" r="140" fill="none" stroke="${STYLE.neon}" stroke-opacity="0.35" stroke-width="2" filter="url(#soft)"/>
       <circle cx="1060" cy="330" r="88" fill="none" stroke="${STYLE.neon}" stroke-opacity="0.2" stroke-width="2"/>
       <circle cx="1060" cy="330" r="10" fill="${STYLE.neon}" filter="url(#glow)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>${DEFS}</defs>
  ${back}
  ${corners()}
  ${tagPill(tag)}
  ${channelMark(channel)}
  ${titleBlock(title, { photo })}
  ${handleMark(handle)}
</svg>`;
}

function renderSvg(svg) {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: W },
    font: { fontFiles: Object.values(FONTS), loadSystemFonts: false, defaultFontFamily: 'Inter' },
  });
  return r.render().asPng();
}

// photo: Buffer с картинкой любого формата, который читает sharp (JPEG, PNG, WebP, AVIF, GIF),
// или null. Картинка, которую не удалось прочитать, заменяется карточкой.
async function renderCover({ title, tag = '', channel = DEFAULTS.channel, handle = DEFAULTS.handle, photo = null } = {}) {
  const head = String(title || '').trim();
  if (!head) throw new Error('нет заголовка');
  let base = null;
  if (photo) {
    try {
      base = await sharp(photo, { failOn: 'none', animated: false })
        .rotate()
        .resize(W, H, { fit: 'cover', position: 'attention' })
        .modulate({ brightness: 0.7, saturation: 0.75 })
        .tint('#B8D8FF')
        .toBuffer();
    } catch {
      base = null;
    }
  }
  const overlay = renderSvg(coverSvg({ title: head, tag, channel, handle, photo: Boolean(base) }));
  const img = base ? sharp(base).composite([{ input: overlay }]) : sharp(overlay);
  return { image: await img.jpeg({ quality: 88, mozjpeg: true }).toBuffer(), photo: Boolean(base) };
}

module.exports = { renderCover, coverSvg, fitTitle, wrap, W, H, STYLE, DEFAULTS };
