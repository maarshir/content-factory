// Узел «Следующий пост»: первый пост из очереди, если сейчас можно публиковать.
// Тихие часы, интервал между публикациями и число попыток в src/publish.config.json.
// Пустой выход (нечего или рано публиковать) завершает запуск без отправки.
// Площадка из поля PLATFORM в «Настройках»: telegram (по умолчанию), vk или max.
// @include src/queue.js as queueLib
// @include src/post.js as postLib
// @include src/plain.js as plainLib
// @include src/publish.config.json as CONFIG

const { DatabaseSync } = require('node:sqlite');
const settings = $('Настройки').first().json;
const platform = postLib.platformOf(settings);
if (!['telegram', 'vk', 'max'].includes(platform)) throw new Error(`публикация на площадку ${platform} пока не поддерживается`);

// Для ВКонтакте нужен номер сообщества: запись уходит на стену с owner_id = -номер.
let ownerId = '';
if (platform === 'vk') {
  const group = String(settings.VK_GROUP_ID ?? '').trim().replace(/^-/, '');
  if (!/^\d+$/.test(group)) throw new Error('в «Настройках» нужен VK_GROUP_ID: номер сообщества цифрами');
  ownerId = '-' + group;
}

// Для MAX нужен номер канала или чата: он уходит в адрес запроса (chat_id), у каналов номер обычно с минусом.
let chatId = '';
if (platform === 'max') {
  chatId = String(settings.MAX_CHAT_ID ?? '').trim();
  if (!/^-?\d+$/.test(chatId)) throw new Error('в «Настройках» нужен MAX_CHAT_ID: номер канала цифрами');
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
  const json = { id: item.id, link: item.link, text, platform, ownerId };
  if (platform === 'max') Object.assign(json, { chatId, format: postLib.MAX_FORMAT });
  return [{ json }];
} finally {
  db.close();
}
