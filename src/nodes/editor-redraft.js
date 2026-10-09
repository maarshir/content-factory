// Узел «Новый черновик»: ответ нейросети на переписывание -> новый черновик в журнал
// и редактору. Если переписать не вышло, редактор получает прежний черновик с причиной:
// запись остаётся в работе, ничего не теряется.
// Пост собирается под площадку PLATFORM из «Настроек», как при сборе, и сверяется
// с описанием из ленты, сохранённым в журнале. У старых записей описания нет,
// для них проверка пропускается.
// @include src/filter.js as filterLib
// @include src/log.js as logLib
// @include src/parse.js as parseLib
// @include src/post.js as postLib
// @include src/overlap.js as overlapLib
// @include src/editor.js as editorLib

const { DatabaseSync } = require('node:sqlite');
const settings = $('Настройки').first().json;
const platform = postLib.platformOf(settings);
const limit = { telegram: postLib.TELEGRAM_TEXT_LIMIT, vk: postLib.VK_TEXT_LIMIT, max: postLib.MAX_TEXT_LIMIT }[platform];
const overlapWords = Number(settings.OVERLAP_WORDS) || overlapLib.DEFAULT_WORDS;
const overlapMax = settings.OVERLAP_MAX ?? overlapLib.DEFAULT_MAX;

const db = new DatabaseSync(settings.CF_DB_PATH);
try {
  const log = logLib.createLog(db, { normalizeUrl: filterLib.normalizeUrl });
  log.init();
  const out = [];
  $input.all().forEach((it, i) => {
    const action = $('Действие').itemMatching(i).json;
    const item = log.byId(action.id);
    if (!item || item.status !== 'collected') return;
    const content = it.json && it.json.choices && it.json.choices[0] && it.json.choices[0].message
      ? it.json.choices[0].message.content
      : null;
    let failure = null;
    let post = null;
    let note = '';
    let relevance = item.relevance;
    if (typeof content !== 'string') {
      failure = 'ошибка запроса к нейросети';
    } else {
      // Порог не применяется: редактор уже решил, что новость нужна.
      const r = parseLib.parseModelResponse(content, { minRelevance: 0 });
      if (!r.ok) {
        failure = r.reason;
      } else {
        try {
          // Запас 200 знаков под строку о переписывании и пометку о совпадениях, как при сборе.
          post = postLib.buildPostFor(
            platform,
            { title: item.title, text: r.text, link: item.link, sourceName: item.source },
            { limit: limit - 200 }
          );
          relevance = r.relevance;
          if (item.description) {
            const same = overlapLib.overlap(r.text, item.description, { words: overlapWords });
            note = overlapLib.overlapNote(same, { max: overlapMax });
          }
        } catch (e) {
          failure = 'пост не собран: ' + e.message;
        }
      }
    }
    if (post) log.drafted(item.link, post.text, { relevance });
    const head = post
      ? `Переписано. Оценка нейросети: ${relevance}/10${post.truncated ? ', текст обрезан' : ''}`
      : `Не переписано (${failure})`;
    out.push({
      json: {
        id: item.id,
        link: item.link,
        rewritten: Boolean(post),
        // Бот редактора шлёт с parse_mode HTML: пост ВКонтакте простым текстом экранируется.
        editorText:
          `${postLib.escapeHtml(head.length > 64 ? head.slice(0, 63) + '…' : head)}` +
          `${note ? '\n' + note : ''}\n\n${editorLib.showPost(post ? post.text : item.post)}`,
      },
    });
  });
  return out;
} finally {
  db.close();
}
