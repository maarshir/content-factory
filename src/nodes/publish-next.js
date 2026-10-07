// Узел «Следующий пост»: первый пост из очереди, если сейчас можно публиковать.
// Тихие часы, интервал между публикациями и число попыток в src/publish.config.json.
// Пустой выход (нечего или рано публиковать) завершает запуск без отправки.
// Площадка из поля PLATFORM в «Настройках»: telegram (по умолчанию) или vk.
// @include src/queue.js as queueLib
// @include src/post.js as postLib
// @include src/plain.js as plainLib
// @include src/publish.config.json as CONFIG

const { DatabaseSync } = require('node:sqlite');
const settings = $('Настройки').first().json;
const platform = postLib.platformOf(settings);

// Для ВКонтакте нужен номер сообщества: запись уходит на стену с owner_id = -номер.
let ownerId = '';
if (platform === 'vk') {
  const group = String(settings.VK_GROUP_ID ?? '').trim().replace(/^-/, '');
  if (!/^\d+$/.test(group)) throw new Error('в «Настройках» нужен VK_GROUP_ID: номер сообщества цифрами');
  ownerId = '-' + group;
}

const db = new DatabaseSync(settings.CF_DB_PATH);
try {
  const queue = queueLib.createQueue(db);
  // Журнала ещё нет: конвейер сбора не запускался.
  if (!queue.init()) return [];
  const { item } = queue.next(CONFIG);
  if (!item) return [];
  // Черновик собран под площадку сбора; если она другая, текст переводится (src/plain.js).
  const text = plainLib.textFor(platform, item.post);
  return [{ json: { id: item.id, link: item.link, text, platform, ownerId } }];
} finally {
  db.close();
}
