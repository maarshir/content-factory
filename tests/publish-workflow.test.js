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
  const chain = ['Расписание', 'Настройки', 'Следующий пост', 'Отправка в канал', 'Итог'];
  const types = ['scheduleTrigger', 'set', 'code', 'telegram', 'code'];
  chain.forEach((name, i) => assert.strictEqual(byName[name] && byName[name].type, 'n8n-nodes-base.' + types[i], name));
  for (let i = 0; i + 1 < chain.length; i++) {
    assert.deepStrictEqual(wf.connections[chain[i]].main[0].map((c) => c.node), [chain[i + 1]], chain[i]);
  }
  assert.strictEqual(wf.active, false);
  // У бота один вебхук, он в editor.json.
  assert.ok(!wf.nodes.some((n) => n.type === 'n8n-nodes-base.telegramTrigger'));
  const settings = byName['Настройки'].parameters.assignments.assignments.map((a) => a.name);
  for (const k of ['TELEGRAM_CHANNEL_ID', 'CF_DB_PATH']) assert.ok(settings.includes(k), k);
  const send = byName['Отправка в канал'];
  assert.match(send.parameters.chatId, /TELEGRAM_CHANNEL_ID/);
  assert.strictEqual(send.parameters.text, '={{ $json.text }}');
  assert.strictEqual(send.parameters.additionalFields.parse_mode, 'HTML');
  assert.strictEqual(send.onError, 'continueRegularOutput');
  assert.ok(!send.retryOnFail, 'повтор отправки может дать пост дважды');
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
  assert.deepStrictEqual(post, { id: log.get('https://example.com/p1').id, link: 'https://example.com/p1', text: '<b>Пост 1</b>' });

  // Синтетический ответ API Телеграма.
  const out = await runNode(wf, 'Итог', j([{ ok: true, result: { message_id: 42 } }]), nodes);
  assert.deepStrictEqual(out[0].json, { id: post.id, status: 'published', messageId: '42', error: '' });
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
