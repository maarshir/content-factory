// Узел «Действие»: нажатие кнопки или ответ на черновик -> решение в журнал.
// «Опубликовать» ставит пост в очередь, «Отклонить» пишет причину, «Переписать»
// готовит промпт для нейросети под площадку PLATFORM. Команды не из чата редактора не выполняются.
// @include src/filter.js as filterLib
// @include src/log.js as logLib
// @include src/editor.js as editorLib
// @include src/post.js as postLib
// @include prompts/rewrite.md as PROMPT

const { DatabaseSync } = require('node:sqlite');
const settings = $('Настройки').first().json;
const update = $('Телеграм').first().json;
const maxLength = Number(settings.MAX_LENGTH) || 1200;
const platform = postLib.platformOf(settings);
const CHANNEL = { telegram: 'Телеграм-канала', vk: 'сообщества ВКонтакте', max: 'канала в мессенджере MAX' };

const cmd = editorLib.parseUpdate(update, { editorChatId: settings.EDITOR_CHAT_ID });
// Чужие сообщения без кнопки остаются без ответа.
if (cmd.kind === 'ignore' && !cmd.callbackQueryId) return [];

let result;
let item = null;
if (cmd.kind === 'button' || cmd.kind === 'reply') {
  const db = new DatabaseSync(settings.CF_DB_PATH);
  try {
    const log = logLib.createLog(db, { normalizeUrl: filterLib.normalizeUrl });
    log.init();
    result = editorLib.applyAction(log, cmd);
    item = log.byId(cmd.id);
  } finally {
    db.close();
  }
} else {
  result = editorLib.applyAction(null, cmd);
}

const prompt = result.rewrite
  ? postLib.fillPrompt(PROMPT, {
      channel: CHANNEL[platform],
      title: item.title,
      link: item.link,
      draft: editorLib.draftBody(item.post, item.title),
      note: result.rewrite.note,
      maxLength,
    })
  : '';

return [
  {
    json: {
      kind: cmd.kind,
      action: cmd.action || '',
      id: cmd.id ?? null,
      callbackQueryId: cmd.callbackQueryId || '',
      chatId: cmd.chatId ?? '',
      messageId: cmd.messageId ?? '',
      answer: result.answer,
      editText: result.editText,
      prompt,
    },
  },
];
