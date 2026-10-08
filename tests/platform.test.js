// Площадка при сборе: промпт и пост под PLATFORM, перевод в простой текст при публикации.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {}
const skip = DatabaseSync ? false : 'нет node:sqlite (нужен Node 22.5+)';

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', f), 'utf8'));
const j = (arr) => arr.map((json) => ({ json }));

// Запуск кода узла Code вне n8n, как в workflows.test.js.
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

test('в «Настройках» сбора есть PLATFORM, по умолчанию telegram', () => {
  const wf = load('collect.json');
  const settings = wf.nodes.find((n) => n.name === 'Настройки').parameters.assignments.assignments;
  assert.strictEqual(settings.find((a) => a.name === 'PLATFORM').value, 'telegram');
});

test('сбор под ВКонтакте: промпт vk.md, простой текст, пометка о совпадениях', { skip }, async () => {
  const wf = load('collect.json');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const db = path.join(tmp, 'log.sqlite');
  const nodes = { Настройки: j([{ CF_DB_PATH: db, PLATFORM: 'vk', OVERLAP_WORDS: 5, OVERLAP_MAX: 0.2 }]), Ленты: j([{ name: 'Пример' }]) };
  // Синтетическая запись ленты.
  const description = 'Компания выложила в открытый доступ языковую модель для русского языка и код обучения.';
  nodes['Отбор'] = await runNode(wf, 'Отбор', j([{ title: 'Открыта модель & код', link: 'https://example.com/v1', contentSnippet: description }]), nodes);
  nodes['Промпт'] = await runNode(wf, 'Промпт', nodes['Отбор'], nodes);
  assert.match(nodes['Промпт'][0].json.prompt, /сообщества ВКонтакте/);
  assert.match(nodes['Промпт'][0].json.prompt, /Заголовок: Открыта модель & код/);

  const answer = (o) => ({ choices: [{ message: { content: JSON.stringify(o) } }] });
  const drafts = await runNode(wf, 'Разбор и пост', j([answer({ relevance: 8, text: description })]), nodes);
  const d = drafts[0].json;
  assert.strictEqual(d.text, `Открыта модель & код\n\n${description}\n\nИсточник: Пример\nhttps://example.com/v1`);
  // Редактору текст уходит с parse_mode HTML, поэтому & экранирован; пометка о совпадениях на месте.
  assert.match(d.editorText, /^Оценка нейросети: 8\/10\nДословно из источника: 100%[^\n]*\n\nОткрыта модель &amp; код\n/);

  const { createLog } = require('../src/log.js');
  const conn = new DatabaseSync(db);
  assert.strictEqual(createLog(conn).byId(d.id).post, d.text);
  conn.close();

  // Без PLATFORM промпт для Телеграма, как раньше.
  const tg = await runNode(wf, 'Промпт', nodes['Отбор'], { ...nodes, Настройки: j([{ CF_DB_PATH: db }]) });
  assert.doesNotMatch(tg[0].json.prompt, /ВКонтакте/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('публикация: пост под ВКонтакте уходит на стену без перевода, в Телеграм экранированным', { skip }, async () => {
  const wf = load('publish.json');
  // Тихие часы выключены, чтобы тест не зависел от времени запуска.
  const node = wf.nodes.find((n) => n.name === 'Следующий пост');
  node.parameters.jsCode = node.parameters.jsCode.replace(/"quietHours":\{[^}]*\},/, '');
  const { createLog } = require('../src/log.js');
  const run = async (settings) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
    const db = path.join(tmp, 'log.sqlite');
    const conn = new DatabaseSync(db);
    const log = createLog(conn);
    log.init();
    const link = 'https://example.com/vk2';
    log.collected({ link, title: 'Пост ВК' });
    log.drafted(link, text);
    log.queued(link);
    const out = await runNode(wf, 'Следующий пост', [], { Настройки: j([{ CF_DB_PATH: db, ...settings }]) });
    conn.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    return out[0].json.text;
  };
  const text = 'Пост ВК\n\nСравнение 2 < 3 и &amp; как есть.\n\nИсточник: example.com\nhttps://example.com/vk2';
  assert.strictEqual(await run({ PLATFORM: 'vk', VK_GROUP_ID: '1' }), text);
  assert.strictEqual(await run({}), text.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
});

test('сбор под MAX: промпт max.md, пост в HTML, редактору без двойного экранирования', { skip }, async () => {
  const wf = load('collect.json');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const db = path.join(tmp, 'log.sqlite');
  const nodes = { Настройки: j([{ CF_DB_PATH: db, PLATFORM: 'max' }]), Ленты: j([{ name: 'Пример' }]) };
  // Синтетическая запись ленты.
  const description = 'Лаборатория выложила в открытый доступ языковую модель для распознавания речи и её веса.';
  nodes['Отбор'] = await runNode(wf, 'Отбор', j([{ title: 'Языковая модель & речь', link: 'https://example.com/m1', contentSnippet: description }]), nodes);
  nodes['Промпт'] = await runNode(wf, 'Промпт', nodes['Отбор'], nodes);
  assert.match(nodes['Промпт'][0].json.prompt, /канала в мессенджере MAX/);

  const text = 'Вышла открытая модель для распознавания речи, веса уже доступны.';
  const answer = { choices: [{ message: { content: JSON.stringify({ relevance: 7, text }) } }] };
  const d = (await runNode(wf, 'Разбор и пост', j([answer]), nodes))[0].json;
  assert.strictEqual(d.text, `<b>Языковая модель &amp; речь</b>\n\n${text}\n\nИсточник: <a href="https://example.com/m1">Пример</a>`);
  assert.ok(d.editorText.endsWith('\n\n' + d.text));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('публикация: площадка без отправки останавливает запуск с понятной ошибкой', { skip }, async () => {
  const wf = load('publish.json');
  await assert.rejects(
    runNode(wf, 'Следующий пост', [], { Настройки: j([{ CF_DB_PATH: ':memory:', PLATFORM: 'max' }]) }),
    /пока не поддерживается/
  );
});
