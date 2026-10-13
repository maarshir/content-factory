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
  assert.ok(files.includes('editor.json'));
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
        // Ключ только в учётных данных n8n: готовый тип (OpenAI), Query Auth (ВКонтакте, Телеграф) или Header Auth (MAX).
        // Без ключа только скачивание статьи и сервис обложек внутри docker compose.
        const open = { Страница: '={{ $json.link }}', Обложка: 'http://cover:3000/cover' };
        const auth = n.parameters.authentication ?? 'none';
        if (auth === 'none') assert.strictEqual(n.parameters.url, open[n.name], `${f}: ${n.name}: запрос без учётных данных`);
        else assert.ok(['predefinedCredentialType', 'genericCredentialType'].includes(auth), `${f}: ${n.name}: ${auth}`);
        if (auth === 'genericCredentialType') {
          assert.ok(['httpQueryAuth', 'httpHeaderAuth'].includes(n.parameters.genericAuthType), `${f}: ${n.name}`);
        }
        const body = ((n.parameters.bodyParameters || {}).parameters || []).map((x) => x.name);
        assert.ok(!body.includes('access_token'), `${f}: ${n.name}: ключ в теле запроса`);
        // Вручную можно задать только User-Agent (статьи без него отдают не все сайты).
        const headers = ((n.parameters.headerParameters || {}).parameters || []).map((x) => x.name);
        assert.ok(headers.every((h) => h === 'User-Agent'), `${f}: ${n.name}: заголовки вручную`);
        assert.ok(!n.parameters.sendQuery, `${f}: ${n.name}: ключ в адресе`);
        assert.doesNotMatch(String(n.parameters.url), /token|access_token|key=/i, `${f}: ${n.name}: ключ в адресе`);
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
  const chain = ['Расписание', 'Настройки', 'Ленты', 'Чтение RSS', 'Отбор', 'Страница', 'Промпт', 'Нейросеть', 'Разбор', 'Подробно?', 'Телеграф', 'Сборка поста', 'С обложкой?', 'Обложка', 'Черновик с обложкой'];
  const types = {
    Расписание: 'n8n-nodes-base.scheduleTrigger',
    Настройки: 'n8n-nodes-base.set',
    'Чтение RSS': 'n8n-nodes-base.rssFeedRead',
    Нейросеть: 'n8n-nodes-base.httpRequest',
    Страница: 'n8n-nodes-base.httpRequest',
    Телеграф: 'n8n-nodes-base.httpRequest',
    Обложка: 'n8n-nodes-base.httpRequest',
    'Черновик с обложкой': 'n8n-nodes-base.telegram',
    'Черновик редактору': 'n8n-nodes-base.telegram',
  };
  for (const name of chain) assert.ok(byName[name], name);
  const outs = (from, i) => (wf.connections[from].main[i] || []).map((c) => c.node);
  // Без подробного пересказа сразу в сборку; без обложки и при ошибках черновик уходит текстом.
  assert.deepStrictEqual(outs('Подробно?', 1), ['Сборка поста']);
  assert.deepStrictEqual(outs('С обложкой?', 1), ['Черновик редактору']);
  assert.deepStrictEqual(outs('Обложка', 1), ['Черновик редактору']);
  assert.deepStrictEqual(outs('Черновик с обложкой', 1), ['Черновик редактору']);
  assert.strictEqual(byName['Обложка'].parameters.url, 'http://cover:3000/cover');
  assert.strictEqual(byName['Обложка'].parameters.options.response.response.responseFormat, 'file');
  assert.strictEqual(byName['Телеграф'].parameters.genericAuthType, 'httpQueryAuth');
  const photo = byName['Черновик с обложкой'].parameters;
  assert.strictEqual(photo.operation, 'sendPhoto');
  assert.strictEqual(photo.binaryData, true);
  assert.strictEqual(photo.additionalFields.parse_mode, 'HTML');
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
  const id = "$json.id ?? $('Сборка поста').item.json.id";
  assert.deepStrictEqual(
    buttons.map((b) => b.additionalFields.callback_data),
    [`=pub:{{ ${id} }}`, `=rew:{{ ${id} }}`, `=rej:{{ ${id} }}`]
  );
  assert.deepStrictEqual(
    photo.inlineKeyboard.rows[0].row.buttons.map((b) => b.additionalFields.callback_data),
    ["=pub:{{ $('Сборка поста').item.json.id }}", "=rew:{{ $('Сборка поста').item.json.id }}", "=rej:{{ $('Сборка поста').item.json.id }}"]
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

// «Разбор» и «Сборка поста» подряд (без страницы Телеграфа), как в конвейере сбора.
async function draftAndBuild(wf, input, nodes) {
  nodes['Разбор'] = await runNode(wf, 'Разбор', input, nodes);
  return runNode(wf, 'Сборка поста', nodes['Разбор'], nodes);
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

  // Страница первой статьи скачалась (картинка и длинный текст), вторая нет.
  const para = 'Модель обучена на корпусе русских текстов и выложена с открытой лицензией, веса доступны для скачивания и дообучения. ';
  const html = `<html><head><meta content="/img/cover.jpg" property="og:image"></head><body><nav><p>Меню сайта и ссылки на разделы</p></nav>
    <article><h1>Заголовок</h1>${[1, 2, 3, 4].map((n) => `<p>Часть ${n}. ${para.repeat(4)}</p>`).join('')}</article></body></html>`;
  nodes['Промпт'] = await runNode(wf, 'Промпт', j([{ html }, { error: 'timeout' }]), nodes);
  const p0 = nodes['Промпт'][0].json;
  assert.match(p0.prompt, /Заголовок: Вышла новая открытая языковая модель/);
  assert.match(p0.prompt, /Модель обучена на корпусе/);
  assert.doesNotMatch(p0.prompt, /Меню сайта/);
  assert.doesNotMatch(p0.prompt, /\{\{/);
  assert.strictEqual(p0.image, 'https://example.com/img/cover.jpg');
  assert.ok(p0.article.length > 1500);
  assert.match(nodes['Промпт'][1].json.prompt, /\(текста статьи нет\)/);

  // Синтетические ответы нейросети: годный с подробным пересказом и с низкой оценкой.
  const answer = (o) => ({ choices: [{ message: { content: '```json\n' + JSON.stringify(o) + '\n```' } }] });
  const full = 'Подробный пересказ статьи о модели. '.repeat(30);
  const llm = j([
    answer({
      relevance: 8, tag: 'модели', emoji: '🧠', title: 'Открыта модель для русского языка',
      lead: 'Открыта новая модель для русского языка, веса и код выложены.',
      points: ['лицензия разрешает дообучение', 'веса уже можно скачать'], full,
    }),
    answer({ relevance: 3, tag: 'события', emoji: '📰', title: 'Слабая новость', lead: 'Слабая новость без подробностей.', points: [], full: '' }),
  ]);
  nodes['Разбор'] = await runNode(wf, 'Разбор', llm, nodes);
  assert.strictEqual(nodes['Разбор'].length, 1);
  const tgReq = nodes['Разбор'][0].json.telegraph;
  assert.strictEqual(tgReq.author_name, 'Нейросети: главное за день');
  assert.match(tgReq.content, /Подробный пересказ/);
  // Ответ Телеграфа приходит в «Сборку поста» вместо черновика.
  const drafts = await runNode(wf, 'Сборка поста', j([{ ok: true, result: { url: 'https://telegra.ph/Otkryta-model-10-13' } }]), nodes);
  assert.strictEqual(drafts.length, 1);
  const d = drafts[0].json;
  assert.strictEqual(d.id, nodes['Отбор'][0].json.id);
  assert.match(d.text, /^🧠 <b>Открыта модель для русского языка<\/b>\n\nОткрыта новая модель/);
  assert.match(d.text, /<blockquote>🔹 лицензия разрешает дообучение\n🔹 веса уже можно скачать<\/blockquote>/);
  assert.match(d.text, /<a href="https:\/\/telegra\.ph\/Otkryta-model-10-13">Читать подробнее<\/a>/);
  assert.match(d.text, /\n#модели$/);
  assert.match(d.editorText, /^Оценка нейросети: 8\/10\n\n🧠 <b>/);
  assert.strictEqual(d.photo, true);
  assert.deepStrictEqual(d.cover, {
    title: 'Открыта модель для русского языка', tag: 'модели', image: 'https://example.com/img/cover.jpg',
    channel: 'Нейросети: главное за день', handle: '@neiro_glav',
  });

  const { createLog } = require('../src/log.js');
  const conn = new DatabaseSync(db);
  const log = createLog(conn);
  assert.strictEqual(log.byId(d.id).post, d.text);
  assert.strictEqual(JSON.parse(log.byId(d.id).card).telegraph, 'https://telegra.ph/Otkryta-model-10-13');
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
  const out = await draftAndBuild(wf, j([{ error: { message: '429' } }]), nodes);
  assert.deepStrictEqual(out, []);
  const conn = new DatabaseSync(db);
  const row = conn.prepare('SELECT status, reason FROM items').get();
  assert.deepStrictEqual({ ...row }, { status: 'rejected', reason: 'ошибка запроса к нейросети' });
  conn.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('сбор: пометка редактору при дословных совпадениях с описанием', { skip }, async () => {
  const wf = load('collect.json');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const db = path.join(tmp, 'log.sqlite');
  const nodes = { Настройки: j([{ CF_DB_PATH: db, OVERLAP_WORDS: 5, OVERLAP_MAX: 0.2 }]), Ленты: j([{ name: 'Пример' }]) };
  // Синтетическая запись ленты с длинным описанием.
  const description =
    'Компания выложила в открытый доступ языковую модель для русского языка. ' +
    'Веса модели можно скачать бесплатно, код обучения опубликован на Гитхабе.';
  const rss = j([
    { title: 'Открыта модель для русского языка', link: 'https://example.com/m1', contentSnippet: description },
    { title: 'Нейросеть для русского языка в открытом доступе', link: 'https://example.com/m2', contentSnippet: description },
  ]);
  nodes['Ленты'] = j(rss.map(() => ({ name: 'Пример' })));
  nodes['Отбор'] = await runNode(wf, 'Отбор', rss, nodes);
  assert.strictEqual(nodes['Отбор'].length, 2);
  nodes['Промпт'] = await runNode(wf, 'Промпт', nodes['Отбор'], nodes);
  const answer = (o) => ({ choices: [{ message: { content: JSON.stringify(o) } }] });
  const card = (lead) => ({ relevance: 8, tag: 'модели', emoji: '🧠', title: 'Открыта модель', lead, points: [], full: '' });
  const drafts = await draftAndBuild(wf, j([
    answer(card('Веса модели можно скачать бесплатно, код обучения опубликован на Гитхабе.')),
    answer(card('Открыта модель для русского: веса бесплатны, обучающий код лежит на Гитхабе.')),
  ]), nodes);
  assert.strictEqual(drafts.length, 2);
  const [copied, own] = drafts.map((d) => d.json);
  assert.strictEqual(copied.overlap, 1);
  assert.match(copied.editorText, /^Оценка нейросети: 8\/10\nДословно из источника: 100% \(порог 20%\), например «веса модели[^\n]*»\n\n🧠 <b>/);
  // В канал пометка не попадает.
  assert.doesNotMatch(copied.text, /Дословно/);
  assert.strictEqual(own.overlap, 0);
  assert.match(own.editorText, /^Оценка нейросети: 8\/10\n\n🧠 <b>/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('бот редактора: узлы, ветки и кнопки', () => {
  const wf = load('editor.json');
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const types = {
    Телеграм: 'n8n-nodes-base.telegramTrigger',
    Настройки: 'n8n-nodes-base.set',
    Действие: 'n8n-nodes-base.code',
    'Нажатие?': 'n8n-nodes-base.if',
    'Ответ на нажатие': 'n8n-nodes-base.telegram',
    'Правка?': 'n8n-nodes-base.if',
    'Правка черновика': 'n8n-nodes-base.telegram',
    'Переписать?': 'n8n-nodes-base.if',
    Нейросеть: 'n8n-nodes-base.httpRequest',
    'Новый черновик': 'n8n-nodes-base.code',
    'Черновик редактору': 'n8n-nodes-base.telegram',
    'Как править?': 'n8n-nodes-base.if',
    'Удалить черновик': 'n8n-nodes-base.telegram',
    Решение: 'n8n-nodes-base.telegram',
    'С обложкой?': 'n8n-nodes-base.if',
    Обложка: 'n8n-nodes-base.httpRequest',
    'Черновик с обложкой': 'n8n-nodes-base.telegram',
  };
  for (const [name, type] of Object.entries(types)) assert.strictEqual(byName[name] && byName[name].type, type, name);
  assert.strictEqual(wf.active, false);
  assert.deepStrictEqual(byName['Телеграм'].parameters.updates, ['callback_query', 'message']);

  const next = (from) => wf.connections[from].main[0].map((c) => c.node);
  assert.deepStrictEqual(next('Телеграм'), ['Настройки']);
  assert.deepStrictEqual(next('Настройки'), ['Действие']);
  assert.deepStrictEqual(next('Действие').sort(), ['Нажатие?', 'Переписать?', 'Правка?']);
  assert.deepStrictEqual(next('Нажатие?'), ['Ответ на нажатие']);
  assert.deepStrictEqual(next('Правка?'), ['Как править?']);
  // Черновик с обложкой удаляется и приходит новым сообщением, текстовый правится на месте.
  assert.deepStrictEqual(next('Как править?'), ['Удалить черновик']);
  assert.deepStrictEqual(wf.connections['Как править?'].main[1].map((c) => c.node), ['Правка черновика']);
  assert.deepStrictEqual(next('Удалить черновик'), ['Решение']);
  assert.strictEqual(byName['Удалить черновик'].parameters.operation, 'deleteMessage');
  assert.deepStrictEqual(next('Переписать?'), ['Нейросеть']);
  assert.deepStrictEqual(next('Нейросеть'), ['Новый черновик']);
  assert.deepStrictEqual(next('Новый черновик'), ['С обложкой?']);
  assert.deepStrictEqual(next('С обложкой?'), ['Обложка']);
  assert.deepStrictEqual(next('Обложка'), ['Черновик с обложкой']);
  for (const n of ['С обложкой?', 'Обложка', 'Черновик с обложкой']) {
    assert.deepStrictEqual(wf.connections[n].main[1].map((c) => c.node), ['Черновик редактору'], n);
  }
  // Ветка «нет» у условий никуда не ведёт.
  for (const n of ['Нажатие?', 'Правка?', 'Переписать?']) assert.ok(!wf.connections[n].main[1] || !wf.connections[n].main[1].length, n);

  const settings = byName['Настройки'].parameters.assignments.assignments.map((a) => a.name);
  for (const k of ['LLM_BASE_URL', 'LLM_MODEL', 'EDITOR_CHAT_ID', 'CF_DB_PATH', 'MAX_LENGTH']) assert.ok(settings.includes(k), k);

  assert.strictEqual(byName['Ответ на нажатие'].parameters.resource, 'callback');
  const edit = byName['Правка черновика'].parameters;
  assert.strictEqual(edit.operation, 'editMessageText');
  assert.strictEqual(edit.additionalFields.parse_mode, 'HTML');
  assert.strictEqual(byName['Нейросеть'].parameters.nodeCredentialType, 'openAiApi');
  const buttons = byName['Черновик редактору'].parameters.inlineKeyboard.rows[0].row.buttons;
  const id = "$json.id ?? $('Новый черновик').item.json.id";
  assert.deepStrictEqual(
    buttons.map((b) => b.additionalFields.callback_data),
    [`=pub:{{ ${id} }}`, `=rew:{{ ${id} }}`, `=rej:{{ ${id} }}`]
  );
  assert.match(byName['Черновик редактору'].parameters.chatId, /EDITOR_CHAT_ID/);
});

// Черновик в журнале, как его оставляет конвейер сбора.
function editorDb() {
  const { createLog } = require('../src/log.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const file = path.join(tmp, 'log.sqlite');
  const conn = new DatabaseSync(file);
  const log = createLog(conn);
  log.init();
  const add = (n) => {
    const { item } = log.collected({ link: `https://example.com/${n}`, title: `Модель ${n} для русского языка`, source: 'Пример' });
    log.drafted(item.link, `<b>Модель ${n} для русского языка</b>\n\nПрежний текст.\n\nИсточник: <a href="https://example.com/${n}">Пример</a>`, { relevance: 7 });
    return item.id;
  };
  const ids = [add(1), add(2), add(3)];
  conn.close();
  const read = (id) => {
    const c = new DatabaseSync(file);
    const row = createLog(c).byId(id);
    c.close();
    return row;
  };
  return { file, ids, read, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

const EDITOR_CHAT = -100500;
const tgPress = (data, chatId = EDITOR_CHAT) => ({
  update_id: 1,
  callback_query: { id: 'q1', data, message: { message_id: 77, chat: { id: chatId } } },
});

test('бот редактора: кнопки на подменённых обновлениях', { skip }, async () => {
  const wf = load('editor.json');
  const db = editorDb();
  const settings = j([{ CF_DB_PATH: db.file, EDITOR_CHAT_ID: String(EDITOR_CHAT), MAX_LENGTH: 900 }]);
  const run = async (update) => {
    const nodes = { Настройки: settings, Телеграм: j([update]) };
    return (await runNode(wf, 'Действие', settings, nodes)).map((x) => x.json);
  };

  const [pub] = await run(tgPress(`pub:${db.ids[0]}`));
  assert.deepStrictEqual([pub.answer, pub.callbackQueryId, pub.chatId, pub.messageId, pub.prompt], ['Поставлено в очередь', 'q1', EDITOR_CHAT, 77, '']);
  assert.match(pub.editText, /^В очереди на публикацию\n\n<b>Модель 1/);
  assert.strictEqual(db.read(db.ids[0]).status, 'queued');

  const [rej] = await run(tgPress(`rej:${db.ids[1]}`));
  assert.strictEqual(rej.answer, 'Отклонено');
  assert.deepStrictEqual([db.read(db.ids[1]).status, db.read(db.ids[1]).reason], ['rejected', 'отклонено редактором']);

  const [denied] = await run(tgPress(`pub:${db.ids[2]}`, 42));
  assert.deepStrictEqual([denied.answer, denied.editText, denied.prompt], ['Нет доступа', '', '']);
  assert.strictEqual(db.read(db.ids[2]).status, 'collected');

  // Сообщение не ответом на черновик: без ответа и без действий.
  assert.deepStrictEqual(await run({ message: { chat: { id: EDITOR_CHAT }, text: 'привет' } }), []);
  db.done();
});

test('бот редактора: «Переписать» с пометкой, новый черновик и сбой нейросети', { skip }, async () => {
  const wf = load('editor.json');
  const db = editorDb();
  const id = db.ids[2];
  const settings = j([{ CF_DB_PATH: db.file, EDITOR_CHAT_ID: String(EDITOR_CHAT), MAX_LENGTH: 900 }]);
  const update = {
    message: {
      message_id: 91,
      chat: { id: EDITOR_CHAT },
      text: 'Короче и без оценок',
      reply_to_message: { message_id: 77, reply_markup: { inline_keyboard: [[{ text: 'Опубликовать', callback_data: `pub:${id}` }]] } },
    },
  };
  const nodes = { Настройки: settings, Телеграм: j([update]) };
  nodes['Действие'] = await runNode(wf, 'Действие', settings, nodes);
  const a = nodes['Действие'][0].json;
  assert.strictEqual(a.callbackQueryId, '');
  assert.match(a.editText, /^Отправлено на переписывание/);
  assert.match(a.prompt, /Пометка редактора: Короче и без оценок/);
  assert.match(a.prompt, /Прежний текст поста:\nПрежний текст\.\n/);
  assert.match(a.prompt, /не длиннее 900 знаков/);
  assert.doesNotMatch(a.prompt, /\{\{|<b>|Источник:/);

  // Синтетический ответ нейросети: оценка ниже порога сбора не мешает, редактор уже решил.
  const answer = { choices: [{ message: { content: JSON.stringify({ relevance: 4, text: 'Новый короткий текст о модели для русского языка без оценок.' }) } }] };
  const [ok] = (await runNode(wf, 'Новый черновик', j([answer]), nodes)).map((x) => x.json);
  assert.strictEqual(ok.id, id);
  assert.strictEqual(ok.rewritten, true);
  assert.match(ok.editorText, /^Переписано\. Оценка нейросети: 4\/10\n\n<b>Модель 3 для русского языка<\/b>\n\nНовый короткий текст/);
  const row = db.read(id);
  assert.deepStrictEqual([row.status, row.relevance], ['collected', 4]);
  assert.match(row.post, /Новый короткий текст/);

  // Ошибка запроса: прежний черновик возвращается редактору, запись не теряется.
  const [fail] = (await runNode(wf, 'Новый черновик', j([{ error: { message: '429' } }]), nodes)).map((x) => x.json);
  assert.strictEqual(fail.rewritten, false);
  assert.match(fail.editorText, /^Не переписано \(ошибка запроса к нейросети\)\n\n<b>Модель 3/);
  assert.strictEqual(db.read(id).post, row.post);
  assert.strictEqual(db.read(id).status, 'collected');
  db.done();
});

test('бот редактора: черновик с обложкой, решение и переписывание по частям', { skip }, async () => {
  const wf = load('editor.json');
  const { createLog } = require('../src/log.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const file = path.join(tmp, 'log.sqlite');
  const conn = new DatabaseSync(file);
  const log = createLog(conn);
  log.init();
  const card = { emoji: '🧠', tag: 'модели', title: 'Открыта модель', lead: 'Прежняя суть новости о модели.', points: ['пункт один'], image: 'https://example.com/i.jpg', telegraph: 'https://telegra.ph/x-10-13' };
  const ids = [1, 2].map((n) => {
    const { item } = log.collected({ link: `https://example.com/c${n}`, title: `Модель ${n}`, source: 'Пример', description: 'Описание из ленты.' });
    log.drafted(item.link, `🧠 <b>Открыта модель</b>\n\nПрежняя суть.`, { relevance: 7, card: JSON.stringify(card) });
    return item.id;
  });
  conn.close();
  const settings = j([{ CF_DB_PATH: file, EDITOR_CHAT_ID: String(EDITOR_CHAT) }]);

  // Нажатие под фото: сообщение заменяется новым.
  const press = tgPress(`pub:${ids[0]}`);
  press.callback_query.message.photo = [{ file_id: 'x' }];
  const [pub] = (await runNode(wf, 'Действие', settings, { Настройки: settings, Телеграм: j([press]) })).map((x) => x.json);
  assert.strictEqual(pub.editMode, 'replace');
  // Текстовый черновик правится на месте.
  const [txt] = (await runNode(wf, 'Действие', settings, { Настройки: settings, Телеграм: j([tgPress(`rew:${ids[1]}`)]) })).map((x) => x.json);
  assert.strictEqual(txt.editMode, 'edit');
  // Промпт переписывания видит суть и пункты, заголовок не меняется.
  assert.match(txt.prompt, /Заголовок и рубрику не меняй/);
  assert.match(txt.prompt, /Прежний пост:\n🧠 Открыта модель\nПрежняя суть новости о модели\.\n- пункт один/);

  const nodes = { Настройки: settings, Действие: j([txt]) };
  const answer = { choices: [{ message: { content: JSON.stringify({ relevance: 5, emoji: '🚀', lead: 'Новая короткая суть о модели.', points: ['новый пункт'] }) } }] };
  const [ok] = (await runNode(wf, 'Новый черновик', j([answer]), nodes)).map((x) => x.json);
  assert.strictEqual(ok.rewritten, true);
  assert.match(ok.editorText, /^Переписано\. Оценка нейросети: 5\/10\n\n🚀 <b>Открыта модель<\/b>\n\nНовая короткая суть/);
  assert.match(ok.editorText, /Читать подробнее/);
  assert.strictEqual(ok.photo, true);
  assert.strictEqual(ok.cover.title, 'Открыта модель');
  const c2 = new DatabaseSync(file);
  const saved = JSON.parse(createLog(c2).byId(ids[1]).card);
  c2.close();
  assert.deepStrictEqual([saved.emoji, saved.lead, saved.title, saved.telegraph], ['🚀', 'Новая короткая суть о модели.', 'Открыта модель', 'https://telegra.ph/x-10-13']);
  fs.rmSync(tmp, { recursive: true, force: true });
});
