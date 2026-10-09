// «Переписать» в боте редактора: пост под площадку PLATFORM и проверка на совпадения
// с описанием из ленты, которое журнал хранит с момента сбора.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLog } = require('../src/log.js');
const { buildPostFor } = require('../src/post.js');
const { draftBody, showPost } = require('../src/editor.js');

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

const EDITOR_CHAT = 555;
// Синтетическая новость: описание из ленты и пересказ своими словами.
const TITLE = 'Открыта модель & код';
const DESCRIPTION = 'Компания выложила в открытый доступ языковую модель для русского языка и код обучения.';
const OWN = 'Разработчики опубликовали веса новой русскоязычной модели вместе со скриптами, на которых её учили.';

// Журнал с одной собранной записью и черновиком под площадку platform.
function setup(platform, { description = DESCRIPTION } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const file = path.join(tmp, 'log.sqlite');
  const conn = new DatabaseSync(file);
  const log = createLog(conn);
  log.init();
  const { item } = log.collected({ link: 'https://example.com/m1', title: TITLE, source: 'Пример', description });
  const fields = { title: TITLE, text: 'Прежний текст.', link: item.link, sourceName: 'Пример' };
  log.drafted(item.link, buildPostFor(platform, fields).text, { relevance: 7 });
  conn.close();
  const settings = j([{ CF_DB_PATH: file, EDITOR_CHAT_ID: String(EDITOR_CHAT), MAX_LENGTH: 900, PLATFORM: platform }]);
  const read = () => {
    const c = new DatabaseSync(file);
    try {
      return createLog(c).byId(item.id);
    } finally {
      c.close();
    }
  };
  return { id: item.id, settings, read, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

const press = (id) => ({
  callback_query: { id: 'q1', data: `rew:${id}`, message: { message_id: 77, chat: { id: EDITOR_CHAT } } },
});
const answer = (o) => ({ choices: [{ message: { content: JSON.stringify(o) } }] });

async function rewrite(db, text) {
  const wf = load('editor.json');
  const nodes = { Настройки: db.settings, Телеграм: j([press(db.id)]) };
  nodes['Действие'] = await runNode(wf, 'Действие', db.settings, nodes);
  const [out] = (await runNode(wf, 'Новый черновик', j([answer({ relevance: 8, text })]), nodes)).map((x) => x.json);
  return { action: nodes['Действие'][0].json, out };
}

test('в «Настройках» бота редактора есть PLATFORM, по умолчанию telegram', () => {
  const settings = load('editor.json').nodes.find((n) => n.name === 'Настройки').parameters.assignments.assignments;
  const byName = Object.fromEntries(settings.map((a) => [a.name, a.value]));
  assert.strictEqual(byName.PLATFORM, 'telegram');
  assert.strictEqual(byName.OVERLAP_WORDS, 5);
  assert.strictEqual(byName.OVERLAP_MAX, 0.2);
});

test('журнал хранит описание из ленты, старый журнал получает пустое поле', { skip }, () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, url_key TEXT NOT NULL UNIQUE, link TEXT NOT NULL,
    title TEXT NOT NULL, source TEXT,
    status TEXT NOT NULL CHECK (status IN ('collected', 'queued', 'rejected', 'published')),
    reason TEXT, relevance REAL, message_id TEXT, post TEXT,
    collected_at TEXT NOT NULL, updated_at TEXT NOT NULL, queued_at TEXT, published_at TEXT);
    INSERT INTO items (url_key, link, title, status, collected_at, updated_at)
    VALUES ('example.com/old', 'https://example.com/old', 'Старая', 'collected', 't', 't');`);
  const log = createLog(db);
  log.init();
  log.init();
  assert.strictEqual(log.byId(1).description, null);
  const { item } = log.collected({ link: 'https://example.com/new', title: 'Новая', description: `  ${DESCRIPTION} ` });
  assert.strictEqual(item.description, DESCRIPTION);
  assert.strictEqual(log.collected({ link: 'https://example.com/none', title: 'Без описания' }).item.description, null);
});

test('сбор сохраняет описание из ленты в журнал', { skip }, async () => {
  const wf = load('collect.json');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const file = path.join(tmp, 'log.sqlite');
  const nodes = { Настройки: j([{ CF_DB_PATH: file }]), Ленты: j([{ name: 'Пример' }]) };
  const [it] = await runNode(wf, 'Отбор', j([{ title: 'Открыта модель для русского языка', link: 'https://example.com/c1', contentSnippet: `<p>${DESCRIPTION}</p>` }]), nodes);
  const conn = new DatabaseSync(file);
  assert.strictEqual(createLog(conn).byId(it.json.id).description, DESCRIPTION);
  conn.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('«Переписать» под ВКонтакте: промпт площадки, простой текст, пометка о совпадениях', { skip }, async () => {
  const db = setup('vk');
  const { action, out } = await rewrite(db, DESCRIPTION);
  assert.match(action.prompt, /^Ты редактор сообщества ВКонтакте/);
  // Нейросеть видит только текст: без заголовка первой строкой и без источника.
  assert.match(action.prompt, /Прежний текст поста:\nПрежний текст\.\n/);
  assert.doesNotMatch(action.prompt, /\{\{|Источник:/);
  // Сообщение о решении: пост ВКонтакте экранирован под parse_mode HTML.
  assert.match(action.editText, /^Отправлено на переписывание\n\nОткрыта модель &amp; код\n/);

  const post = `${TITLE}\n\n${DESCRIPTION}\n\nИсточник: Пример\nhttps://example.com/m1`;
  assert.strictEqual(out.rewritten, true);
  assert.strictEqual(db.read().post, post);
  assert.match(out.editorText, /^Переписано\. Оценка нейросети: 8\/10\nДословно из источника: 100%[^\n]*\n\nОткрыта модель &amp; код\n/);
  db.done();
});

test('«Переписать» под MAX: HTML, пересказ своими словами без пометки', { skip }, async () => {
  const db = setup('max');
  const { action, out } = await rewrite(db, OWN);
  assert.match(action.prompt, /^Ты редактор канала в мессенджере MAX/);
  const row = db.read();
  assert.strictEqual(row.post, buildPostFor('max', { title: TITLE, text: OWN, link: 'https://example.com/m1', sourceName: 'Пример' }).text);
  assert.match(row.post, /^<b>Открыта модель &amp; код<\/b>\n\n/);
  assert.match(out.editorText, /^Переписано\. Оценка нейросети: 8\/10\n\n<b>Открыта модель/);
  assert.doesNotMatch(out.editorText, /Дословно/);
  db.done();
});

test('«Переписать» под Телеграм по умолчанию; без описания проверка пропускается', { skip }, async () => {
  const db = setup('telegram', { description: '' });
  db.settings[0].json.PLATFORM = '';
  const { action, out } = await rewrite(db, DESCRIPTION);
  assert.match(action.prompt, /^Ты редактор Телеграм-канала/);
  assert.match(db.read().post, /^<b>Открыта модель &amp; код<\/b>\n\n[^<]+\n\nИсточник: <a href="https:\/\/example\.com\/m1">Пример<\/a>$/);
  assert.doesNotMatch(out.editorText, /Дословно/);
  db.done();
});

test('сбой нейросети: прежний пост ВКонтакте возвращается редактору экранированным', { skip }, async () => {
  const db = setup('vk');
  const wf = load('editor.json');
  const nodes = { Настройки: db.settings, Телеграм: j([press(db.id)]) };
  nodes['Действие'] = await runNode(wf, 'Действие', db.settings, nodes);
  const before = db.read().post;
  const [out] = (await runNode(wf, 'Новый черновик', j([{ error: { message: '429' } }]), nodes)).map((x) => x.json);
  assert.strictEqual(out.rewritten, false);
  assert.match(out.editorText, /^Не переписано \(ошибка запроса к нейросети\)\n\nОткрыта модель &amp; код\n/);
  assert.strictEqual(db.read().post, before);
  db.done();
});

test('текст черновика ВКонтакте для нейросети и показ поста редактору', () => {
  const vk = `${TITLE}\n\nПервый абзац.\n\nВторой.\n\nИсточник: Пример\nhttps://example.com/m1`;
  assert.strictEqual(draftBody(vk, TITLE), 'Первый абзац.\n\nВторой.');
  // Без заголовка первый абзац не теряется.
  assert.strictEqual(draftBody('Первый абзац.\n\nВторой.', TITLE), 'Первый абзац.\n\nВторой.');
  assert.strictEqual(showPost('a & <b>'), 'a & <b>');
  assert.strictEqual(showPost('a & b < c'), 'a &amp; b &lt; c');
});
