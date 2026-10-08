const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLog } = require('../src/log.js');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {}
const skip = DatabaseSync ? false : 'нет node:sqlite (нужен Node 22.5+)';

const load = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'publish.json'), 'utf8'));
const j = (arr) => arr.map((json) => ({ json }));

// Запуск кода узла Code вне n8n, как runNode в workflows.test.js.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function runNode(wf, name, input, nodes) {
  const node = wf.nodes.find((n) => n.name === name);
  const wrap = (items) => ({ all: () => items, first: () => items[0], itemMatching: (i) => items[i] });
  const $ = (n) => {
    if (!nodes[n]) throw new Error(`нет данных узла ${n}`);
    return wrap(nodes[n]);
  };
  const req = (m) => {
    if (m !== 'node:sqlite') throw new Error(`модуль закрыт: ${m}`);
    return require(m);
  };
  return new AsyncFunction('$input', '$', 'require', node.parameters.jsCode)(wrap(input), $, req);
}

test('публикация: узлы и порядок', () => {
  const wf = load();
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const types = {
    Расписание: 'scheduleTrigger',
    Настройки: 'set',
    'Следующий пост': 'code',
    Площадка: 'if',
    'Отправка во ВКонтакте': 'httpRequest',
    'MAX или Телеграм': 'if',
    'Отправка в MAX': 'httpRequest',
    'Отправка в канал': 'telegram',
    Итог: 'code',
  };
  for (const [name, t] of Object.entries(types)) {
    assert.strictEqual(byName[name] && byName[name].type, 'n8n-nodes-base.' + t, name);
  }
  const next = (name) => wf.connections[name].main.map((out) => out.map((c) => c.node));
  assert.deepStrictEqual(next('Расписание'), [['Настройки']]);
  assert.deepStrictEqual(next('Настройки'), [['Следующий пост']]);
  assert.deepStrictEqual(next('Следующий пост'), [['Площадка']]);
  // Первый выход if (условие верно) ведёт во ВКонтакте, второй к выбору между MAX и Телеграмом.
  assert.deepStrictEqual(next('Площадка'), [['Отправка во ВКонтакте'], ['MAX или Телеграм']]);
  assert.deepStrictEqual(next('MAX или Телеграм'), [['Отправка в MAX'], ['Отправка в канал']]);
  assert.deepStrictEqual(next('Отправка во ВКонтакте'), [['Итог']]);
  assert.deepStrictEqual(next('Отправка в MAX'), [['Итог']]);
  assert.deepStrictEqual(next('Отправка в канал'), [['Итог']]);
  const cond = (name) => byName[name].parameters.conditions.conditions.map((c) => [c.leftValue, c.operator.operation, c.rightValue]);
  assert.deepStrictEqual(cond('Площадка'), [['={{ $json.platform }}', 'equals', 'vk']]);
  assert.deepStrictEqual(cond('MAX или Телеграм'), [['={{ $json.platform }}', 'equals', 'max']]);
  assert.strictEqual(wf.active, false);
  // У бота один вебхук, он в editor.json.
  assert.ok(!wf.nodes.some((n) => n.type === 'n8n-nodes-base.telegramTrigger'));
  const settings = Object.fromEntries(byName['Настройки'].parameters.assignments.assignments.map((a) => [a.name, a.value]));
  for (const k of ['TELEGRAM_CHANNEL_ID', 'CF_DB_PATH', 'PLATFORM', 'VK_GROUP_ID', 'MAX_CHAT_ID']) assert.ok(k in settings, k);
  assert.strictEqual(settings.PLATFORM, 'telegram');
  const send = byName['Отправка в канал'];
  assert.match(send.parameters.chatId, /TELEGRAM_CHANNEL_ID/);
  assert.strictEqual(send.parameters.text, '={{ $json.text }}');
  assert.strictEqual(send.parameters.additionalFields.parse_mode, 'HTML');
  for (const name of ['Отправка в канал', 'Отправка во ВКонтакте', 'Отправка в MAX']) {
    assert.strictEqual(byName[name].onError, 'continueRegularOutput', name);
    assert.ok(!byName[name].retryOnFail, `${name}: повтор отправки может дать пост дважды`);
  }
  const vk = byName['Отправка во ВКонтакте'].parameters;
  assert.strictEqual(vk.method, 'POST');
  assert.strictEqual(vk.url, 'https://api.vk.com/method/wall.post');
  const body = Object.fromEntries(vk.bodyParameters.parameters.map((p) => [p.name, p.value]));
  assert.strictEqual(body.owner_id, '={{ $json.ownerId }}');
  assert.strictEqual(body.from_group, '1');
  assert.strictEqual(body.message, '={{ $json.text }}');
  assert.match(body.v, /^5\.\d+$/);
});

test('публикация: узел «Отправка в MAX» берёт ключ только из учётных данных', () => {
  const wf = load();
  const node = wf.nodes.find((n) => n.name === 'Отправка в MAX');
  const p = node.parameters;
  assert.strictEqual(p.method, 'POST');
  assert.strictEqual(p.url, '=https://platform-api2.max.ru/messages?chat_id={{ $json.chatId }}');
  // Ключ в заголовке Authorization через учётные данные Header Auth, в адресе MAX его не принимает.
  assert.strictEqual(p.authentication, 'genericCredentialType');
  assert.strictEqual(p.genericAuthType, 'httpHeaderAuth');
  assert.ok(!p.sendHeaders && !p.headerParameters, 'заголовки только через учётные данные');
  assert.doesNotMatch(p.url, /token|key|authorization/i);
  assert.strictEqual(p.jsonBody, '={{ JSON.stringify({ text: $json.text, format: $json.format }) }}');
  assert.doesNotMatch(p.jsonBody, /token|key|authorization/i);
  assert.ok(!('credentials' in node) || !JSON.stringify(node.credentials).match(/[A-Za-z0-9_-]{30,}/));
  // Ответ с ошибкой API нужен в «Итоге» целиком, с кодом и текстом.
  assert.strictEqual(p.options.response.response.neverError, true);
});

// Тихие часы зависят от времени запуска теста, поэтому в узел подставляется настройка без них.
function withoutQuiet(wf) {
  const node = wf.nodes.find((n) => n.name === 'Следующий пост');
  const code = node.parameters.jsCode.replace(/"quietHours":\{[^}]*\},/, '');
  assert.notStrictEqual(code, node.parameters.jsCode);
  node.parameters.jsCode = code;
  return wf;
}

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const db = path.join(tmp, 'log.sqlite');
  const conn = new DatabaseSync(db);
  const log = createLog(conn);
  log.init();
  for (const n of [1, 2]) {
    const link = `https://example.com/p${n}`;
    log.collected({ link, title: `Пост ${n}` });
    log.drafted(link, `<b>Пост ${n}</b>`);
    log.queued(link);
  }
  const done = () => {
    conn.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { log, done, nodes: { Настройки: j([{ CF_DB_PATH: db, TELEGRAM_CHANNEL_ID: '@example' }]) } };
}

test('публикация: пост уходит в канал и помечается опубликованным', { skip }, async () => {
  const wf = withoutQuiet(load());
  const { log, done, nodes } = setup();
  nodes['Следующий пост'] = await runNode(wf, 'Следующий пост', [], nodes);
  assert.strictEqual(nodes['Следующий пост'].length, 1);
  const post = nodes['Следующий пост'][0].json;
  assert.deepStrictEqual(post, {
    id: log.get('https://example.com/p1').id,
    link: 'https://example.com/p1',
    text: '<b>Пост 1</b>',
    platform: 'telegram',
    ownerId: '',
  });

  // Синтетический ответ API Телеграма.
  const out = await runNode(wf, 'Итог', j([{ ok: true, result: { message_id: 42 } }]), nodes);
  assert.deepStrictEqual(out[0].json, { id: post.id, platform: 'telegram', status: 'published', messageId: '42', error: '' });
  const row = log.get('https://example.com/p1');
  assert.strictEqual(row.status, 'published');
  assert.strictEqual(row.message_id, '42');

  // Сразу после публикации следующий пост ждёт интервала.
  assert.deepStrictEqual(await runNode(wf, 'Следующий пост', [], nodes), []);
  done();
});

test('публикация: ошибка Телеграма в журнал, пост остаётся в очереди', { skip }, async () => {
  const wf = withoutQuiet(load());
  const { log, done, nodes } = setup();
  nodes['Следующий пост'] = await runNode(wf, 'Следующий пост', [], nodes);
  const out = await runNode(wf, 'Итог', j([{ error: 'Bad Request: chat not found' }]), nodes);
  assert.strictEqual(out[0].json.status, 'queued');
  assert.strictEqual(out[0].json.attempts, 1);
  const row = log.get('https://example.com/p1');
  assert.strictEqual(row.status, 'queued');
  assert.strictEqual(row.reason, 'ошибка Телеграма: Bad Request: chat not found');
  // Ответ без номера сообщения тоже ошибка.
  await runNode(wf, 'Итог', j([{ ok: true }]), nodes);
  assert.match(log.get('https://example.com/p1').reason, /нет номера сообщения/);
  // Следующий запуск снова берёт этот же пост.
  const again = await runNode(wf, 'Следующий пост', [], nodes);
  assert.strictEqual(again[0].json.link, 'https://example.com/p1');
  done();
});

test('публикация: пустая очередь завершает запуск без отправки', { skip }, async () => {
  const wf = withoutQuiet(load());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const nodes = { Настройки: j([{ CF_DB_PATH: path.join(tmp, 'log.sqlite') }]) };
  assert.deepStrictEqual(await runNode(wf, 'Следующий пост', [], nodes), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Синтетический пост из журнала в разметке Телеграма, как его собирает конвейер сбора.
function setupVk(group = '123456') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const db = path.join(tmp, 'log.sqlite');
  const conn = new DatabaseSync(db);
  const log = createLog(conn);
  log.init();
  const link = 'https://example.com/vk1';
  log.collected({ link, title: 'Пост ВК' });
  log.drafted(link, '<b>Пост &amp; ВК</b>\n\nТекст.\n\nИсточник: <a href="https://example.com/vk1">example.com</a>');
  log.queued(link);
  const done = () => {
    conn.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  const nodes = { Настройки: j([{ CF_DB_PATH: db, PLATFORM: 'vk', VK_GROUP_ID: group }]) };
  return { log, done, nodes, link };
}

test('публикация во ВКонтакте: простой текст на стену сообщества, номер записи в журнал', { skip }, async () => {
  const wf = withoutQuiet(load());
  const { log, done, nodes, link } = setupVk();
  nodes['Следующий пост'] = await runNode(wf, 'Следующий пост', [], nodes);
  const post = nodes['Следующий пост'][0].json;
  assert.strictEqual(post.platform, 'vk');
  assert.strictEqual(post.ownerId, '-123456');
  assert.strictEqual(post.text, 'Пост & ВК\n\nТекст.\n\nИсточник: example.com\nhttps://example.com/vk1');
  assert.doesNotMatch(post.text, /<|&amp;/);

  // Синтетический ответ wall.post.
  const out = await runNode(wf, 'Итог', j([{ response: { post_id: 77 } }]), nodes);
  assert.deepStrictEqual(out[0].json, { id: post.id, platform: 'vk', status: 'published', messageId: '77', error: '' });
  const row = log.get(link);
  assert.strictEqual(row.status, 'published');
  assert.strictEqual(row.message_id, '77');
  done();
});

test('публикация во ВКонтакте: ошибка API в журнал, пост остаётся в очереди', { skip }, async () => {
  const wf = withoutQuiet(load());
  const { log, done, nodes, link } = setupVk();
  nodes['Следующий пост'] = await runNode(wf, 'Следующий пост', [], nodes);
  // Синтетический ответ с ошибкой в формате API ВКонтакте.
  const out = await runNode(wf, 'Итог', j([{ error: { error_code: 15, error_msg: 'Access denied' } }]), nodes);
  assert.strictEqual(out[0].json.status, 'queued');
  assert.strictEqual(out[0].json.attempts, 1);
  assert.strictEqual(log.get(link).reason, 'ошибка ВКонтакте: 15: Access denied');
  // Сбой самого запроса (узел HTTP Request с continueRegularOutput).
  await runNode(wf, 'Итог', j([{ error: { message: 'getaddrinfo ENOTFOUND api.vk.com' } }]), nodes);
  assert.strictEqual(log.get(link).reason, 'ошибка ВКонтакте: getaddrinfo ENOTFOUND api.vk.com');
  // Ответ без номера записи тоже ошибка.
  await runNode(wf, 'Итог', j([{ response: {} }]), nodes);
  assert.match(log.get(link).reason, /нет номера записи/);
  assert.strictEqual(log.get(link).status, 'queued');
  done();
});

test('публикация во ВКонтакте: без номера сообщества запуск падает с понятной ошибкой', { skip }, async () => {
  const wf = withoutQuiet(load());
  for (const group of ['', 'club123']) {
    const { done, nodes } = setupVk(group);
    await assert.rejects(runNode(wf, 'Следующий пост', [], nodes), /VK_GROUP_ID/);
    done();
  }
  // Номер с минусом тоже принимается.
  const { done, nodes } = setupVk('-42');
  const out = await runNode(wf, 'Следующий пост', [], nodes);
  assert.strictEqual(out[0].json.ownerId, '-42');
  done();
});

// Синтетический черновик под MAX (HTML, как у Телеграма).
function setupMax(chat = '-1001234') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const db = path.join(tmp, 'log.sqlite');
  const conn = new DatabaseSync(db);
  const log = createLog(conn);
  log.init();
  const link = 'https://example.com/max1';
  log.collected({ link, title: 'Пост MAX' });
  log.drafted(link, '<b>Пост MAX</b>\n\nТекст.\n\nИсточник: <a href="https://example.com/max1">example.com</a>');
  log.queued(link);
  const done = () => {
    conn.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  const nodes = { Настройки: j([{ CF_DB_PATH: db, PLATFORM: 'max', MAX_CHAT_ID: chat }]) };
  return { log, done, nodes, link };
}

test('публикация в MAX: HTML в канал, номер сообщения в журнал', { skip }, async () => {
  const wf = withoutQuiet(load());
  const { log, done, nodes, link } = setupMax();
  nodes['Следующий пост'] = await runNode(wf, 'Следующий пост', [], nodes);
  const post = nodes['Следующий пост'][0].json;
  assert.strictEqual(post.platform, 'max');
  assert.strictEqual(post.chatId, '-1001234');
  assert.strictEqual(post.format, 'html');
  assert.strictEqual(post.text, '<b>Пост MAX</b>\n\nТекст.\n\nИсточник: <a href="https://example.com/max1">example.com</a>');

  // Синтетический ответ POST /messages.
  const out = await runNode(wf, 'Итог', j([{ message: { body: { mid: 'mid.abc123', text: post.text } } }]), nodes);
  assert.deepStrictEqual(out[0].json, { id: post.id, platform: 'max', status: 'published', messageId: 'mid.abc123', error: '' });
  assert.strictEqual(log.get(link).status, 'published');
  assert.strictEqual(log.get(link).message_id, 'mid.abc123');
  done();
});

test('публикация в MAX: ошибка в журнал «ошибка MAX: код: текст», пост остаётся в очереди', { skip }, async () => {
  const wf = withoutQuiet(load());
  const { log, done, nodes, link } = setupMax();
  nodes['Следующий пост'] = await runNode(wf, 'Следующий пост', [], nodes);
  // Синтетический ответ с ошибкой.
  const out = await runNode(wf, 'Итог', j([{ code: 'verify.token', message: 'Invalid access_token' }]), nodes);
  assert.strictEqual(out[0].json.status, 'queued');
  assert.strictEqual(out[0].json.attempts, 1);
  assert.strictEqual(log.get(link).reason, 'ошибка MAX: verify.token: Invalid access_token');
  // Сбой самого запроса.
  await runNode(wf, 'Итог', j([{ error: { message: 'getaddrinfo ENOTFOUND platform-api2.max.ru' } }]), nodes);
  assert.strictEqual(log.get(link).reason, 'ошибка MAX: getaddrinfo ENOTFOUND platform-api2.max.ru');
  // Ответ без номера сообщения тоже ошибка.
  await runNode(wf, 'Итог', j([{ message: { body: {} } }]), nodes);
  assert.match(log.get(link).reason, /нет номера сообщения в ответе MAX/);
  assert.strictEqual(log.get(link).status, 'queued');
  done();
});

test('публикация в MAX: без номера канала запуск падает с понятной ошибкой', { skip }, async () => {
  const wf = withoutQuiet(load());
  for (const chat of ['', '@channel']) {
    const { done, nodes } = setupMax(chat);
    await assert.rejects(runNode(wf, 'Следующий пост', [], nodes), /MAX_CHAT_ID/);
    done();
  }
});
