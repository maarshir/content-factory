// Узел «Итог»: ответ площадки -> журнал. Есть номер сообщения: пост опубликован.
// Ошибка Телеграма, ВКонтакте или MAX пишется в журнал, пост остаётся в очереди до следующего запуска.
// Журнал уже подготовлен узлом «Следующий пост» (queue.init).
// @include src/queue.js as queueLib

const { DatabaseSync } = require('node:sqlite');
const settings = $('Настройки').first().json;
const post = $('Следующий пост').first().json;
const res = $input.first().json || {};
const platform = ['vk', 'max'].includes(post.platform) ? post.platform : 'telegram';

const errorText = (e) => (e && typeof e === 'object' ? e.description || e.error_msg || e.message || JSON.stringify(e) : e);

let messageId;
let error;
if (platform === 'vk') {
  // wall.post: { response: { post_id } }, ошибка API { error: { error_code, error_msg } }.
  // Сбой самого запроса узел HTTP Request отдаёт как { error: { message } }.
  messageId = res.response && res.response.post_id;
  if (res.error && typeof res.error === 'object' && res.error.error_code != null) {
    error = `${res.error.error_code}: ${res.error.error_msg || 'без описания'}`;
  } else {
    error = errorText(res.error) || 'нет номера записи в ответе ВКонтакте';
  }
} else if (platform === 'max') {
  // POST /messages: { message: { body: { mid } } } (https://dev.max.ru/docs-api/methods/POST/messages,
  // номер сообщения mid в теле сообщения). Узел отдаёт ответ с ошибкой как есть (neverError):
  // { code, message }. Сбой самого запроса: { error: { message } }.
  const body = res.message && typeof res.message === 'object' ? res.message.body : null;
  messageId = body && body.mid;
  if (res.code != null && res.code !== '') {
    error = `${res.code}: ${typeof res.message === 'string' && res.message ? res.message : 'без описания'}`;
  } else {
    error = errorText(res.error) || 'нет номера сообщения в ответе MAX';
  }
} else {
  // Узел Telegram отдаёт ответ API ({ ok, result: { message_id } }), при ошибке { error }.
  messageId = res.result && res.result.message_id != null ? res.result.message_id : res.message_id;
  error = errorText(res.error) || 'нет номера сообщения в ответе Телеграма';
}

const db = new DatabaseSync(settings.CF_DB_PATH);
try {
  const queue = queueLib.createQueue(db);
  if (messageId != null && String(messageId) !== '') {
    queue.published(post.id, messageId);
    return [{ json: { id: post.id, platform, status: 'published', messageId: String(messageId), error: '' } }];
  }
  const row = queue.failed(post.id, String(error), platform);
  return [{ json: { id: post.id, platform, status: 'queued', messageId: '', error: String(error), attempts: row.attempts } }];
} finally {
  db.close();
}
