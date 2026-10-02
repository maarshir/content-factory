const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../scripts/build-workflows.js');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'workflows');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const raw = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const load = (f) => JSON.parse(raw(f));

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {}
const skip = DatabaseSync ? false : 'нет node:sqlite (нужен Node 22.5+)';

test('конвейеры разбираются и связи ведут к существующим узлам', () => {
  assert.ok(files.includes('collect.json'));
  for (const f of files) {
    const wf = load(f);
    assert.ok(wf.name, f);
    const names = new Set(wf.nodes.map((n) => n.name));
    assert.strictEqual(names.size, wf.nodes.length, `${f}: имена узлов повторяются`);
    for (const [from, c] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), `${f}: нет узла ${from}`);
      for (const out of c.main) for (const to of out) assert.ok(names.has(to.node), `${f}: нет узла ${to.node}`);
    }
  }
});

test('в конвейерах нет ключей, токенов и доступа к окружению', () => {
  const secrets = [
    /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI
    /\bgsk_[A-Za-z0-9]{16,}/, // Groq
    /\b\d{8,10}:[A-Za-z0-9_-]{30,}/, // токен бота Телеграма
    /Bearer\s+[A-Za-z0-9._-]{10,}/i,
    /"(apiKey|accessToken|token|password)"\s*:/i,
  ];
  for (const f of files) {
    const text = raw(f);
    for (const re of secrets) assert.doesNotMatch(text, re, `${f}: похоже на ключ`);
    assert.doesNotMatch(text, /\$env\b|process\.env/, `${f}: доступ к окружению закрыт`);
    for (const n of load(f).nodes) {
      if (n.credentials) {
        // Ссылка на учётные данные n8n (id и имя) без самих ключей.
        for (const c of Object.values(n.credentials)) {
          for (const k of Object.keys(c)) assert.ok(['id', 'name'].includes(k), `${f}: ${n.name}: ${k}`);
        }
      }
      if (n.type === 'n8n-nodes-base.httpRequest') {
        assert.strictEqual(n.parameters.authentication, 'predefinedCredentialType', `${f}: ${n.name}`);
        assert.ok(!n.parameters.sendHeaders && !n.parameters.headerParameters, `${f}: ${n.name}: заголовки вручную`);
        assert.ok(!n.parameters.sendQuery, `${f}: ${n.name}: ключ в адресе`);
      }
    }
  }
});

test('код узлов Code совпадает с src/ (npm run build)', () => {
  assert.deepStrictEqual(build({ write: false }), []);
});

test('узлам Code нужен только node:sqlite', () => {
  for (const f of files) {
    for (const n of load(f).nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
      const mods = [...n.parameters.jsCode.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
      // './filter.js' вызывается в log.js внутри try и в n8n не нужен: узлы передают normalizeUrl сами.
      for (const m of mods) assert.ok(['node:sqlite', './filter.js'].includes(m), `${f}: ${n.name}: ${m}`);
      if (mods.includes('./filter.js')) assert.match(n.parameters.jsCode, /normalizeUrl: filterLib\.normalizeUrl/);
    }
  }
});

test('сбор: узлы и порядок', () => {
  const wf = load('collect.json');
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const chain = ['Расписание', 'Настройки', 'Ленты', 'Чтение RSS', 'Отбор', 'Промпт', 'Нейросеть', 'Разбор и пост', 'Черновик редактору'];
  const types = {
    Расписание: 'n8n-nodes-base.scheduleTrigger',
    Настройки: 'n8n-nodes-base.set',
    'Чтение RSS': 'n8n-nodes-base.rssFeedRead',
    Нейросеть: 'n8n-nodes-base.httpRequest',
    'Черновик редактору': 'n8n-nodes-base.telegram',
  };
  for (const name of chain) assert.ok(byName[name], name);
  for (const [name, type] of Object.entries(types)) assert.strictEqual(byName[name].type, type, name);
  for (let i = 0; i + 1 < chain.length; i++) {
    assert.strictEqual(wf.connections[chain[i]].main[0][0].node, chain[i + 1], chain[i]);
  }
  assert.strictEqual(wf.active, false);

  const settings = byName['Настройки'].parameters.assignments.assignments.map((a) => a.name);
  for (const k of ['LLM_BASE_URL', 'LLM_MODEL', 'EDITOR_CHAT_ID', 'CF_DB_PATH']) assert.ok(settings.includes(k), k);

  assert.strictEqual(byName['Нейросеть'].parameters.nodeCredentialType, 'openAiApi');
  assert.match(byName['Нейросеть'].parameters.url, /\/chat\/completions$/);

  const tg = byName['Черновик редактору'].parameters;
  const buttons = tg.inlineKeyboard.rows[0].row.buttons;
  assert.deepStrictEqual(buttons.map((b) => b.text), ['Опубликовать', 'Переписать', 'Отклонить']);
  assert.deepStrictEqual(
    buttons.map((b) => b.additionalFields.callback_data),
    ['=pub:{{ $json.id }}', '=rew:{{ $json.id }}', '=rej:{{ $json.id }}']
  );
  assert.strictEqual(tg.additionalFields.parse_mode, 'HTML');
  assert.match(tg.chatId, /EDITOR_CHAT_ID/);
});

// Запуск кода узла Code вне n8n: $input, $('Узел') и require как в узле.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function runNode(wf, name, input, nodes) {
  const node = wf.nodes.find((n) => n.name === name);
  const wrap = (items) => ({
    all: () => items,
    first: () => items[0],
    itemMatching: (i) => items[i],
  });
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

const j = (arr) => arr.map((json) => ({ json }));

test('сбор: от лент до черновика на подменённых данных', { skip }, async () => {
  const wf = load('collect.json');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const db = path.join(tmp, 'log.sqlite');
  const nodes = { Настройки: j([{ CF_DB_PATH: db, MAX_ITEMS: 5, MAX_LENGTH: 800, MIN_RELEVANCE: 6 }]) };

  nodes['Ленты'] = await runNode(wf, 'Ленты', [], nodes);
  assert.ok(nodes['Ленты'].length >= 3);
  assert.ok(nodes['Ленты'].every((x) => /^https:\/\//.test(x.json.url)));

  // Синтетические записи лент.
  const rss = j([
    { title: 'Вышла новая открытая языковая модель', link: 'https://example.com/a?utm_source=rss', contentSnippet: 'Модель для русского языка.' },
    { title: 'Гороскоп на неделю для нейросети', link: 'https://example.com/b', contentSnippet: '' },
    { title: 'Курс рубля вырос', link: 'https://example.com/c', contentSnippet: 'Новости рынка.' },
    { title: 'Вышла новая открытая языковая модель', link: 'https://example.com/a', contentSnippet: 'Повтор.' },
    { error: 'лента недоступна' },
    { title: 'Нейросеть научилась читать рукописи', link: 'https://example.com/d', content: '<p>Текст <b>с тегами</b></p>' },
  ]);
  nodes['Ленты'] = j(rss.map(() => ({ name: 'Пример' })));
  nodes['Отбор'] = await runNode(wf, 'Отбор', rss, nodes);
  assert.deepStrictEqual(nodes['Отбор'].map((x) => x.json.link), ['https://example.com/a?utm_source=rss', 'https://example.com/d']);
  assert.strictEqual(nodes['Отбор'][1].json.description, 'Текст с тегами');
  assert.strictEqual(nodes['Отбор'][0].json.source, 'Пример');

  // Повторный запуск на тех же лентах ничего нового не даёт.
  assert.deepStrictEqual(await runNode(wf, 'Отбор', rss, nodes), []);

  nodes['Промпт'] = await runNode(wf, 'Промпт', nodes['Отбор'], nodes);
  assert.match(nodes['Промпт'][0].json.prompt, /Заголовок: Вышла новая открытая языковая модель/);
  assert.match(nodes['Промпт'][0].json.prompt, /не длиннее 800 знаков/);
  assert.doesNotMatch(nodes['Промпт'][0].json.prompt, /\{\{/);

  // Синтетические ответы нейросети: годный и с низкой оценкой.
  const answer = (o) => ({ choices: [{ message: { content: '```json\n' + JSON.stringify(o) + '\n```' } }] });
  const llm = j([
    answer({ relevance: 8, text: 'Открыта новая модель для русского языка. Веса и код выложены, проверить можно уже сейчас.' }),
    answer({ relevance: 3, text: 'Слабая новость без подробностей, читателям канала мало пользы.' }),
  ]);
  const drafts = await runNode(wf, 'Разбор и пост', llm, nodes);
  assert.strictEqual(drafts.length, 1);
  const d = drafts[0].json;
  assert.strictEqual(d.id, nodes['Отбор'][0].json.id);
  assert.match(d.text, /^<b>Вышла новая открытая языковая модель<\/b>/);
  assert.match(d.text, /Источник: <a href="https:\/\/example\.com\/a\?utm_source=rss">Пример<\/a>$/);
  assert.match(d.editorText, /^Оценка нейросети: 8\/10\n\n<b>/);

  const { createLog } = require('../src/log.js');
  const conn = new DatabaseSync(db);
  const log = createLog(conn);
  assert.strictEqual(log.byId(d.id).post, d.text);
  const s = log.stats();
  assert.strictEqual(s.collected, 1);
  const reasons = Object.fromEntries(s.reasons.map((r) => [r.reason, r.count]));
  assert.deepStrictEqual(reasons, { 'нет ключевых слов': 1, 'стоп-слово': 1, 'ниже порога релевантности': 1 });
  conn.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('сбор: ошибка запроса к нейросети записывается в журнал', { skip }, async () => {
  const wf = load('collect.json');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const db = path.join(tmp, 'log.sqlite');
  const nodes = { Настройки: j([{ CF_DB_PATH: db }]), Ленты: j([{ name: 'Пример' }]) };
  nodes['Отбор'] = await runNode(wf, 'Отбор', j([{ title: 'ИИ помогает врачам', link: 'https://example.com/x' }]), nodes);
  nodes['Промпт'] = await runNode(wf, 'Промпт', nodes['Отбор'], nodes);
  const out = await runNode(wf, 'Разбор и пост', j([{ error: { message: '429' } }]), nodes);
  assert.deepStrictEqual(out, []);
  const conn = new DatabaseSync(db);
  const row = conn.prepare('SELECT status, reason FROM items').get();
  assert.deepStrictEqual({ ...row }, { status: 'rejected', reason: 'ошибка запроса к нейросети' });
  conn.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
