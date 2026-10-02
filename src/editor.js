// Бот редактора: разбор нажатий кнопок и ответов на черновик, действие над журналом.
// Файл без зависимостей: вклеивается в узел Code n8n (src/nodes/editor-action.js).
//
// Кнопки под черновиком шлют pub:<номер>, rew:<номер>, rej:<номер>.
// Ответом (reply) на черновик редактор может написать пометку для переписывания,
// а текст, начатый с «отклонить:», отклоняет черновик с этой причиной.
'use strict';

const ACTIONS = { pub: 'publish', rew: 'rewrite', rej: 'reject' };
const CALLBACK = /^(pub|rew|rej):(\d+)$/;
const REJECT_REPLY = /^\s*(отклонить|отклонено|отказ)\s*[:.,-]?\s*/i;
const DEFAULT_NOTE = 'Перепиши иначе: другие формулировки, яснее и короче.';
const NOTE_LIMIT = 500;

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function short(s, limit) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= limit ? t : t.slice(0, limit - 1).trimEnd() + '…';
}

// Номер записи из клавиатуры сообщения с черновиком.
function idFromKeyboard(markup) {
  const rows = (markup && markup.inline_keyboard) || [];
  for (const row of rows) {
    for (const b of row || []) {
      const m = String((b && b.callback_data) || '').match(CALLBACK);
      if (m) return Number(m[2]);
    }
  }
  return null;
}

// Обновление Телеграма -> команда редактора.
// kind: 'button' (нажатие), 'reply' (ответ на черновик), 'denied' (чужой чат), 'ignore'.
function parseUpdate(update, options = {}) {
  const editor = String(options.editorChatId ?? '').trim();
  const allowed = (chatId) => editor !== '' && String(chatId) === editor;
  const u = update || {};

  if (u.callback_query) {
    const q = u.callback_query;
    const msg = q.message || {};
    const chatId = msg.chat ? msg.chat.id : null;
    const base = { callbackQueryId: String(q.id || ''), chatId, messageId: msg.message_id ?? null };
    if (!allowed(chatId)) return { kind: 'denied', ...base };
    const m = String(q.data || '').match(CALLBACK);
    if (!m) return { kind: 'ignore', ...base };
    return { kind: 'button', action: ACTIONS[m[1]], id: Number(m[2]), note: '', ...base };
  }

  const msg = u.message;
  if (msg && msg.reply_to_message && typeof msg.text === 'string') {
    const chatId = msg.chat ? msg.chat.id : null;
    if (!allowed(chatId)) return { kind: 'ignore' };
    const id = idFromKeyboard(msg.reply_to_message.reply_markup);
    if (id === null) return { kind: 'ignore' };
    const base = { callbackQueryId: '', chatId, messageId: msg.reply_to_message.message_id, id };
    const text = msg.text.trim();
    if (REJECT_REPLY.test(text)) {
      return { kind: 'reply', action: 'reject', note: short(text.replace(REJECT_REPLY, ''), NOTE_LIMIT), ...base };
    }
    if (!text) return { kind: 'ignore' };
    return { kind: 'reply', action: 'rewrite', note: short(text, NOTE_LIMIT), ...base };
  }

  return { kind: 'ignore' };
}

const STATUS_ANSWER = {
  queued: 'Уже в очереди',
  published: 'Уже опубликовано',
  rejected: 'Уже отклонено',
};

// Текст сообщения с черновиком после решения: строка о решении, затем пост.
// Строка не длиннее 64 знаков: столько оставляет под неё сборка поста.
function decided(line, post) {
  return `${escapeHtml(short(line, 64))}\n\n${post}`;
}

// Выполняет команду над журналом (log из createLog). Возвращает
// { answer, editText, rewrite }: ответ на нажатие, новый текст сообщения с черновиком
// (пусто, если менять не нужно) и данные для переписывания (или null).
function applyAction(log, cmd) {
  const none = { answer: '', editText: '', rewrite: null };
  if (!cmd || cmd.kind === 'ignore') return { ...none, answer: cmd && cmd.callbackQueryId ? 'Неизвестная кнопка' : '' };
  if (cmd.kind === 'denied') return { ...none, answer: 'Нет доступа' };

  const item = log.byId(cmd.id);
  if (!item) return { ...none, answer: 'Черновик не найден' };
  if (item.status !== 'collected') return { ...none, answer: STATUS_ANSWER[item.status] || 'Уже решено' };
  if (!item.post) return { ...none, answer: 'У записи нет черновика' };

  if (cmd.action === 'publish') {
    log.queued(item.link);
    return { answer: 'Поставлено в очередь', editText: decided('В очереди на публикацию', item.post), rewrite: null };
  }
  if (cmd.action === 'reject') {
    const reason = cmd.note ? `редактор: ${cmd.note}` : 'отклонено редактором';
    log.rejected(item.link, reason);
    return { answer: 'Отклонено', editText: decided(`Отклонено (${reason})`, item.post), rewrite: null };
  }
  if (cmd.action === 'rewrite') {
    const note = cmd.note || DEFAULT_NOTE;
    return {
      answer: 'Отправлено на переписывание',
      editText: decided('Отправлено на переписывание', item.post),
      rewrite: { id: item.id, note },
    };
  }
  return { ...none, answer: 'Неизвестная кнопка' };
}

function unescapeHtml(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// Текст черновика без заголовка, строки источника и разметки: его видит нейросеть.
function draftBody(post) {
  const parts = String(post ?? '').split('\n\n');
  if (parts.length > 1 && /^<b>/.test(parts[0])) parts.shift();
  if (parts.length > 1 && /^Источник: /.test(parts[parts.length - 1])) parts.pop();
  return unescapeHtml(parts.join('\n\n').replace(/<[^>]*>/g, '')).trim();
}

if (typeof module !== 'undefined') {
  module.exports = { ACTIONS, DEFAULT_NOTE, parseUpdate, applyAction, draftBody, idFromKeyboard };
}
