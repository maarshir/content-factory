// Узел «Следующий пост»: первый пост из очереди, если сейчас можно публиковать.
// Тихие часы, интервал между публикациями и число попыток в src/publish.config.json.
// Пустой выход (нечего или рано публиковать) завершает запуск без отправки.
// @include src/queue.js as queueLib
// @include src/publish.config.json as CONFIG

const { DatabaseSync } = require('node:sqlite');
const settings = $('Настройки').first().json;

const db = new DatabaseSync(settings.CF_DB_PATH);
try {
  const queue = queueLib.createQueue(db);
  // Журнала ещё нет: конвейер сбора не запускался.
  if (!queue.init()) return [];
  const { item } = queue.next(CONFIG);
  if (!item) return [];
  return [{ json: { id: item.id, link: item.link, text: item.post } }];
} finally {
  db.close();
}
