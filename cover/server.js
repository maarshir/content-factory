// Сервис обложек для n8n: POST /cover с JSON { title, tag, image, channel, handle }
// отдаёт JPEG 1280×720. Картинку по адресу image скачивает сам; не скачалась или
// её нет, рисует фирменную карточку. Заголовок X-Cover-Photo: 1 (фото) или 0 (карточка).
// Доступен только внутри сети docker compose, наружу порт не открывается.
'use strict';

const http = require('node:http');
const dns = require('node:dns/promises');
const net = require('node:net');
const { renderCover } = require('./render.js');

const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 64 * 1024;
const MAX_IMAGE = 15 * 1024 * 1024;
const TIMEOUT = 12000;
const UA = 'Mozilla/5.0 (compatible; content-factory-cover/1.0)';

// Адреса внутренней сети не скачиваются: адрес картинки приходит со сторонних страниц.
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const s = ip.toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80') || s.startsWith('::ffff:');
}

async function safeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) return null;
  return u;
}

async function download(raw) {
  let url = await safeUrl(raw);
  // Переадресации проверяются так же, не больше трёх.
  for (let hop = 0; url && hop < 4; hop++) {
    const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA, accept: 'image/*' }, signal: AbortSignal.timeout(TIMEOUT) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await safeUrl(new URL(res.headers.get('location'), url).href);
      continue;
    }
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type)) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_IMAGE) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length && buf.length <= MAX_IMAGE ? buf : null;
  }
  return null;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('слишком большой запрос'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('тело запроса не JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/cover') {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readJson(req);
    const photo = body.image ? await download(body.image).catch(() => null) : null;
    const out = await renderCover({
      title: body.title,
      tag: body.tag,
      channel: body.channel || undefined,
      handle: body.handle ?? undefined,
      photo,
    });
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': out.image.length,
      'content-disposition': 'inline; filename="cover.jpg"',
      'x-cover-photo': out.photo ? '1' : '0',
    });
    res.end(out.image);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: e.message }));
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`обложки на порту ${PORT}`));
}

module.exports = { server, privateIp, safeUrl };
