// Узел «Итог»: ответ Телеграма -> журнал. Есть номер сообщения: пост опубликован.
// Ошибка Телеграма пишется в журнал, пост остаётся в очереди до следующего запуска.
// Журнал уже подготовлен узлом «Следующий пост» (queue.init).
// @include src/queue.js as queueLib

const { DatabaseSync } = require('node:sqlite');
const settings = $('Настройки').first().json;
const post = $('Следующий пост').first().json;
const res = $input.first().json || {};

// Узел Telegram отдаёт ответ API ({ ok, result: { message_id } }), при ошибке { error }.
const messageId = res.result && res.result.message_id != null ? res.result.message_id : res.message_id;
const errorText = (e) => (e && typeof e === 'object' ? e.description || e.message || JSON.stringify(e) : e);

const db = new DatabaseSync(settings.CF_DB_PATH);
try {
  const queue = queueLib.createQueue(db);
  if (messageId != null && String(messageId) !== '') {
    queue.published(post.id, messageId);
    return [{ json: { id: post.id, status: 'published', messageId: String(messageId), error: '' } }];
  }
  const error = String(errorText(res.error) || 'нет номера сообщения в ответе Телеграма');
  const row = queue.failed(post.id, error);
  return [{ json: { id: post.id, status: 'queued', messageId: '', error, attempts: row.attempts } }];
} finally {
  db.close();
}
