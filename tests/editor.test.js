const { test } = require('node:test');
const assert = require('node:assert');
const { parseUpdate, applyAction, draftBody, idFromKeyboard, DEFAULT_NOTE } = require('../src/editor.js');
const { createLog } = require('../src/log.js');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {}
const skip = DatabaseSync ? false : 'нет node:sqlite (нужен Node 22.5+)';

const EDITOR = '-100500';
const keyboard = (id) => ({
  inline_keyboard: [[
    { text: 'Опубликовать', callback_data: `pub:${id}` },
    { text: 'Переписать', callback_data: `rew:${id}` },
    { text: 'Отклонить', callback_data: `rej:${id}` },
  ]],
});
const press = (data, chatId = -100500) => ({
  update_id: 1,
  callback_query: { id: 'q1', data, message: { message_id: 77, chat: { id: chatId } } },
});
const reply = (text, id = 3, chatId = -100500) => ({
  update_id: 2,
  message: { message_id: 90, chat: { id: chatId }, text, reply_to_message: { message_id: 77, reply_markup: keyboard(id) } },
});

test('нажатия кнопок разбираются в команды', () => {
  assert.deepStrictEqual(parseUpdate(press('pub:12'), { editorChatId: EDITOR }), {
    kind: 'button', action: 'publish', id: 12, note: '', callbackQueryId: 'q1', chatId: -100500, messageId: 77,
  });
  assert.strictEqual(parseUpdate(press('rew:5'), { editorChatId: EDITOR }).action, 'rewrite');
  assert.strictEqual(parseUpdate(press('rej:5'), { editorChatId: EDITOR }).action, 'reject');
  assert.strictEqual(parseUpdate(press('del:5'), { editorChatId: EDITOR }).kind, 'ignore');
  assert.strictEqual(parseUpdate(press('pub:5 OR 1'), { editorChatId: EDITOR }).kind, 'ignore');
});

test('доступ только из чата редактора', () => {
  assert.strictEqual(parseUpdate(press('pub:1', 123), { editorChatId: EDITOR }).kind, 'denied');
  // Без настроенного чата редактора доступа нет ни у кого.
  assert.strictEqual(parseUpdate(press('pub:1'), { editorChatId: '' }).kind, 'denied');
  assert.strictEqual(parseUpdate(press('pub:1'), {}).kind, 'denied');
  assert.deepStrictEqual(parseUpdate(reply('короче', 3, 123), { editorChatId: EDITOR }), { kind: 'ignore' });
});

test('ответ на черновик: пометка для переписывания или отказ с причиной', () => {
  const r = parseUpdate(reply('  Короче, без цифр  '), { editorChatId: EDITOR });
  assert.deepStrictEqual(r, {
    kind: 'reply', action: 'rewrite', note: 'Короче, без цифр', callbackQueryId: '', chatId: -100500, messageId: 77, id: 3,
  });
  const x = parseUpdate(reply('Отклонить: реклама'), { editorChatId: EDITOR });
  assert.deepStrictEqual([x.action, x.note], ['reject', 'реклама']);
  assert.strictEqual(parseUpdate(reply('отклонить'), { editorChatId: EDITOR }).note, '');
  assert.strictEqual(parseUpdate(reply('х'.repeat(900)), { editorChatId: EDITOR }).note.length, 500);
  // Сообщения без ответа на черновик и ответы на чужие сообщения пропускаются.
  assert.strictEqual(parseUpdate({ message: { chat: { id: -100500 }, text: '/start' } }, { editorChatId: EDITOR }).kind, 'ignore');
  const other = reply('текст');
  other.message.reply_to_message.reply_markup = undefined;
  assert.strictEqual(parseUpdate(other, { editorChatId: EDITOR }).kind, 'ignore');
  assert.strictEqual(parseUpdate({}, { editorChatId: EDITOR }).kind, 'ignore');
  assert.strictEqual(idFromKeyboard(keyboard(42)), 42);
  assert.strictEqual(idFromKeyboard(null), null);
});

function setup() {
  const log = createLog(new DatabaseSync(':memory:'));
  log.init();
  const add = (n, post = `<b>Новость ${n}</b>\n\nТекст &amp; подробности.\n\nИсточник: <a href="https://example.com/${n}">Пример</a>`) => {
    const { item } = log.collected({ link: `https://example.com/${n}`, title: `Новость ${n}`, source: 'Пример' });
    if (post) log.drafted(item.link, post, { relevance: 7 });
    return item.id;
  };
  return { log, add };
}
const btn = (action, id, note = '') => ({ kind: 'button', action, id, note, callbackQueryId: 'q', chatId: 1, messageId: 2 });

test('«Опубликовать» ставит в очередь, повторное нажатие ничего не меняет', { skip }, () => {
  const { log, add } = setup();
  const id = add(1);
  const r = applyAction(log, btn('publish', id));
  assert.strictEqual(r.answer, 'Поставлено в очередь');
  assert.match(r.editText, /^В очереди на публикацию\n\n<b>Новость 1<\/b>/);
  assert.strictEqual(r.rewrite, null);
  assert.strictEqual(log.byId(id).status, 'queued');
  assert.deepStrictEqual(applyAction(log, btn('publish', id)), { answer: 'Уже в очереди', editText: '', rewrite: null });
  assert.strictEqual(applyAction(log, btn('reject', id)).answer, 'Уже в очереди');
  assert.strictEqual(log.byId(id).status, 'queued');
});

test('«Отклонить» пишет причину в журнал', { skip }, () => {
  const { log, add } = setup();
  const a = add(1);
  const b = add(2);
  const r = applyAction(log, btn('reject', a));
  assert.strictEqual(r.answer, 'Отклонено');
  assert.strictEqual(log.byId(a).reason, 'отклонено редактором');
  applyAction(log, { ...btn('reject', b, 'реклама <b>'), kind: 'reply' });
  assert.strictEqual(log.byId(b).reason, 'редактор: реклама <b>');
  assert.match(applyAction(log, btn('publish', b)).answer, /Уже отклонено/);
});

test('«Переписать» не меняет статус и отдаёт пометку', { skip }, () => {
  const { log, add } = setup();
  const id = add(1);
  const r = applyAction(log, btn('rewrite', id));
  assert.deepStrictEqual(r.rewrite, { id, note: DEFAULT_NOTE });
  assert.strictEqual(log.byId(id).status, 'collected');
  assert.deepStrictEqual(applyAction(log, btn('rewrite', id, 'короче')).rewrite, { id, note: 'короче' });
});

test('нет записи, нет черновика, чужой чат', { skip }, () => {
  const { log, add } = setup();
  const id = add(1, null);
  assert.strictEqual(applyAction(log, btn('publish', 999)).answer, 'Черновик не найден');
  assert.strictEqual(applyAction(log, btn('publish', id)).answer, 'У записи нет черновика');
  assert.strictEqual(log.byId(id).status, 'collected');
  assert.deepStrictEqual(applyAction(null, { kind: 'denied', callbackQueryId: 'q' }), { answer: 'Нет доступа', editText: '', rewrite: null });
  assert.strictEqual(applyAction(null, { kind: 'ignore' }).answer, '');
});

test('текст черновика для нейросети без заголовка, источника и разметки', () => {
  assert.strictEqual(
    draftBody('<b>Заголовок</b>\n\nПервый &lt;абзац&gt; &amp; ещё.\n\nВторой.\n\nИсточник: <a href="https://e.com">E</a>'),
    'Первый <абзац> & ещё.\n\nВторой.'
  );
  assert.strictEqual(draftBody('Просто текст'), 'Просто текст');
});
