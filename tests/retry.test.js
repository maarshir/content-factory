const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { telegramError, planRetry } = require('../src/retry.js');

// Синтетические ответы Телеграма в форме из Bot API и в том виде, как их отдаёт узел n8n.
const api429 = (s) => ({
  ok: false,
  error_code: 429,
  description: `Too Many Requests: retry after ${s}`,
  parameters: { retry_after: s },
});

test('429: retry_after из ответа Bot API, строки и вложенного JSON', () => {
  assert.deepStrictEqual(telegramError(api429(5)), { tooMany: true, retryAfter: 5, text: 'Too Many Requests: retry after 5' });
  assert.strictEqual(telegramError({ error: 'Too Many Requests: retry after 12' }).retryAfter, 12);
  assert.strictEqual(telegramError({ error: { message: 'ошибка', description: JSON.stringify(api429(7)) } }).retryAfter, 7);
  const n8n = telegramError({ error: { message: 'The service is receiving too many requests from you', httpCode: '429' } });
  assert.deepStrictEqual(n8n, { tooMany: true, retryAfter: null, text: 'The service is receiving too many requests from you' });
});

test('другие ошибки не считаются 429', () => {
  const e = telegramError({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" });
  assert.strictEqual(e.tooMany, false);
  assert.strictEqual(e.text, "Bad Request: can't parse entities");
  assert.strictEqual(telegramError({}).text, 'без описания');
});

test('план: ждать retry_after и повторять до 3 раз', () => {
  assert.deepStrictEqual(planRetry(api429(5), 0), { retry: true, wait: 5, attempt: 1 });
  assert.deepStrictEqual(planRetry(api429(5), 2), { retry: true, wait: 5, attempt: 3 });
  assert.deepStrictEqual(planRetry(api429(5), 3), { retry: false, reason: 'черновик не отправлен редактору: 429 после 3 повторов' });
  assert.deepStrictEqual(planRetry(api429(0), 0), { retry: true, wait: 1, attempt: 1 });
});

test('план: без retry_after пауза растёт, слишком долгое ожидание не ждём', () => {
  const noHint = { error: { message: 'Too Many Requests', httpCode: '429' } };
  assert.deepStrictEqual([0, 1, 2].map((a) => planRetry(noHint, a).wait), [10, 20, 30]);
  assert.deepStrictEqual(planRetry(api429(90), 0), { retry: false, reason: 'черновик не отправлен редактору: 429, ждать 90 с' });
  assert.strictEqual(planRetry(api429(90), 0, { maxWait: 120 }).wait, 90);
});

test('план: ошибка не 429 и неизвестный номер попытки без повтора', () => {
  assert.deepStrictEqual(planRetry({ error: 'Bad Request: chat not found' }, 0), {
    retry: false,
    reason: 'черновик не отправлен редактору: Bad Request: chat not found',
  });
  assert.strictEqual(planRetry(api429(5), undefined).retry, false);
  assert.strictEqual(planRetry(api429(5), -1).retry, false);
});

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {}
const skip = DatabaseSync ? false : 'нет node:sqlite (нужен Node 22.5+)';

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
  return new AsyncFunction('$input', '$', 'require', node.parameters.jsCode)({ ...wrap(input) }, $, req);
}

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'collect.json'), 'utf8'));

test('сбор: ошибки черновика уходят в «Повтор черновика», пауза ведёт обратно на отправку', () => {
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  assert.strictEqual(byName['Черновик редактору'].onError, 'continueErrorOutput');
  const main = wf.connections['Черновик редактору'].main;
  assert.deepStrictEqual(main[0], []);
  assert.deepStrictEqual(main[1].map((c) => c.node), ['Повтор черновика']);
  assert.strictEqual(byName['Повтор черновика'].type, 'n8n-nodes-base.code');
  assert.strictEqual(byName['Пауза'].type, 'n8n-nodes-base.wait');
  assert.strictEqual(byName['Пауза'].parameters.unit, 'seconds');
  assert.match(byName['Пауза'].parameters.amount, /\$json\.wait/);
  assert.deepStrictEqual(wf.connections['Повтор черновика'].main[0].map((c) => c.node), ['Пауза']);
  assert.deepStrictEqual(wf.connections['Пауза'].main[0].map((c) => c.node), ['Черновик редактору']);
});

test('сбор: 429 повторяется трижды, затем причина в журнале и статус collected', { skip }, async () => {
  const { createLog } = require('../src/log.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const dbPath = path.join(tmp, 'log.sqlite');
  const conn = new DatabaseSync(dbPath);
  const log = createLog(conn);
  log.init();
  const links = ['https://example.com/1', 'https://example.com/2'];
  const drafts = links.map((link, i) => {
    log.collected({ link, title: `Новость ${i + 1}` });
    const row = log.drafted(link, `<b>Текст ${i + 1}</b> про 429`);
    return { id: row.id, link, relevance: 8, text: row.post, editorText: row.post, attempt: 0 };
  });

  const nodes = { Настройки: [{ json: { CF_DB_PATH: dbPath } }], 'Разбор и пост': drafts.map((json) => ({ json })) };
  // Элемент ошибки: входные поля и текст ошибки, как в выходе ошибок узла n8n.
  const fail = (d, error) => ({ json: { ...d, error } });

  let items = [fail(drafts[0], 'Too Many Requests: retry after 4'), fail(drafts[1], "Bad Request: can't parse entities")];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const out = await runNode(wf, 'Повтор черновика', items, nodes);
    assert.strictEqual(out.length, 1, `попытка ${attempt}`);
    assert.deepStrictEqual([out[0].json.link, out[0].json.attempt, out[0].json.wait], [links[0], attempt, 4]);
    assert.strictEqual(out[0].json.editorText, drafts[0].editorText);
    items = [fail(out[0].json, 'Too Many Requests: retry after 4')];
  }
  assert.deepStrictEqual(await runNode(wf, 'Повтор черновика', items, nodes), []);

  const rows = conn.prepare('SELECT link, status, reason FROM items ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepStrictEqual(rows, [
    { link: links[0], status: 'collected', reason: 'черновик не отправлен редактору: 429 после 3 повторов' },
    { link: links[1], status: 'collected', reason: "черновик не отправлен редактору: Bad Request: can't parse entities" },
  ]);
  // Слово «429» в тексте черновика не делает ошибку разметки ошибкой 429, черновик не меняется.
  assert.strictEqual(log.get(links[1]).post, '<b>Текст 2</b> про 429');
  conn.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('журнал: причина недоставки только у собранной записи, статус не меняется', { skip }, () => {
  const { markUndelivered } = require('../src/retry.js');
  const { createLog } = require('../src/log.js');
  const db = new DatabaseSync(':memory:');
  const log = createLog(db);
  log.init();
  const a = log.collected({ link: 'https://example.com/a', title: 'Новость' }).item;
  assert.throws(() => markUndelivered(db, a.id, ' '), /причина/);
  assert.strictEqual(markUndelivered(db, 999, 'x'), false);
  assert.strictEqual(markUndelivered(db, a.id, 'черновик не отправлен'), true);
  assert.deepStrictEqual([log.byId(a.id).status, log.byId(a.id).reason], ['collected', 'черновик не отправлен']);
  log.rejected('https://example.com/a', 'редактор отклонил');
  assert.strictEqual(markUndelivered(db, a.id, 'x'), false);
  assert.strictEqual(log.byId(a.id).reason, 'редактор отклонил');
});
