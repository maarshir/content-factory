// Узел «Сборка поста»: части поста -> пост под площадку -> черновик в журнал.
// Приходит из «Разбора» напрямую или через «Телеграф» (ответ createPage со ссылкой).
// Пересказ сверяется с описанием из ленты (overlap.js): при большой доле дословных
// совпадений редактор видит пометку над черновиком.
// Телеграм: пост подписью к обложке (до 1024 знаков), обложку рисует сервис cover/.
// @include src/filter.js as filterLib
// @include src/log.js as logLib
// @include src/post.js as postLib
// @include src/overlap.js as overlapLib
// @include src/card.js as cardLib

const { DatabaseSync } = require('node:sqlite');
const settings = $('Настройки').first().json;
const overlapWords = Number(settings.OVERLAP_WORDS) || overlapLib.DEFAULT_WORDS;
const overlapMax = settings.OVERLAP_MAX ?? overlapLib.DEFAULT_MAX;
const platform = postLib.platformOf(settings);
const channel = cardLib.channelOf(settings);
const limit = { telegram: postLib.TELEGRAM_CAPTION_LIMIT, vk: postLib.VK_TEXT_LIMIT, max: postLib.MAX_TEXT_LIMIT }[platform];
// Запас под строки с оценкой и пометкой о совпадениях в сообщении редактору:
// черновик с обложкой тоже подпись, и у неё тот же предел 1024.
const RESERVE = 160;

const db = new DatabaseSync(settings.CF_DB_PATH);
try {
  const log = logLib.createLog(db, { normalizeUrl: filterLib.normalizeUrl });
  log.init();
  const out = [];
  $input.all().forEach((it, i) => {
    const fromTelegraph = !(it.json && it.json.draft);
    const d = fromTelegraph ? $('Разбор').itemMatching(i).json : it.json;
    let post;
    let card = null;
    try {
      if (d.card) {
        card = { ...d.card, telegraph: fromTelegraph ? cardLib.telegraphUrl(it.json) : '' };
        post = postLib.buildCardPost(
          { ...card, link: d.link, sourceName: d.source, telegraph: card.telegraph },
          { limit: limit - RESERVE }
        );
      } else {
        post = postLib.buildPostFor(
          platform,
          { title: d.title, text: d.text, link: d.link, sourceName: d.source },
          { limit: limit - 200 }
        );
      }
    } catch (e) {
      log.rejected(d.link, 'пост не собран: ' + e.message, { relevance: d.relevance });
      return;
    }
    log.drafted(d.link, post.text, { relevance: d.relevance, card: card ? cardLib.storeCard(card) : null });
    const same = overlapLib.overlap(d.text, d.description, { words: overlapWords });
    const note = overlapLib.overlapNote(same, { max: overlapMax });
    // Бот редактора в Телеграме с разметкой HTML: простой текст для ВКонтакте экранируется,
    // пост для MAX уже в HTML с теми же тегами <b> и <a>.
    const shown = platform === 'vk' ? postLib.escapeHtml(post.text) : post.text;
    const flags = [post.truncated ? 'текст обрезан' : '', card && fromTelegraph && !card.telegraph ? 'Телеграф не ответил' : '']
      .filter(Boolean)
      .join(', ');
    const head = `Оценка нейросети: ${d.relevance}/10${flags ? ', ' + flags : ''}`;
    const editorText = `${head}${note ? '\n' + note : ''}\n\n${shown}`;
    out.push({
      json: {
        id: d.id,
        link: d.link,
        relevance: d.relevance,
        text: post.text,
        // Номер повтора отправки редактору, считает узел «Повтор черновика».
        attempt: 0,
        overlap: Math.round(same.ratio * 100) / 100,
        // Редактору видны оценка нейросети и пометка о совпадениях, в канал они не попадают.
        editorText,
        // Черновик с обложкой, если влезает в подпись; иначе обычным сообщением.
        photo: Boolean(card) && postLib.visibleLength(editorText) <= postLib.TELEGRAM_CAPTION_LIMIT,
        cover: card ? cardLib.coverRequest(card, channel) : null,
      },
      pairedItem: { item: i },
    });
  });
  return out;
} finally {
  db.close();
}
