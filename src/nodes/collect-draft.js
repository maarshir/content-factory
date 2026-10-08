// Узел «Разбор и пост»: ответ нейросети -> parse.js -> post.js -> черновик в журнал.
// Отказ модели, низкая оценка и ошибка запроса пишутся в журнал с причиной.
// Пересказ сверяется с описанием из ленты (overlap.js): при большой доле дословных
// совпадений редактор видит пометку над черновиком.
// Пост собирается под площадку PLATFORM из «Настроек»: telegram и max (HTML) или vk (простой текст).
// @include src/filter.js as filterLib
// @include src/log.js as logLib
// @include src/parse.js as parseLib
// @include src/post.js as postLib
// @include src/overlap.js as overlapLib

const { DatabaseSync } = require('node:sqlite');
const settings = $('Настройки').first().json;
const minRelevance = Number(settings.MIN_RELEVANCE ?? 6);
const overlapWords = Number(settings.OVERLAP_WORDS) || overlapLib.DEFAULT_WORDS;
const overlapMax = settings.OVERLAP_MAX ?? overlapLib.DEFAULT_MAX;
const platform = postLib.platformOf(settings);
const limit = { telegram: postLib.TELEGRAM_TEXT_LIMIT, vk: postLib.VK_TEXT_LIMIT, max: postLib.MAX_TEXT_LIMIT }[platform];

const db = new DatabaseSync(settings.CF_DB_PATH);
try {
  const log = logLib.createLog(db, { normalizeUrl: filterLib.normalizeUrl });
  log.init();
  const out = [];
  $input.all().forEach((it, i) => {
    const news = $('Промпт').itemMatching(i).json;
    const content = it.json && it.json.choices && it.json.choices[0] && it.json.choices[0].message
      ? it.json.choices[0].message.content
      : null;
    if (typeof content !== 'string') {
      log.rejected(news.link, 'ошибка запроса к нейросети');
      return;
    }
    const r = parseLib.parseModelResponse(content, { minRelevance });
    if (!r.ok) {
      log.rejected(news.link, r.reason, { relevance: r.relevance });
      return;
    }
    let post;
    try {
      // Запас 200 знаков под строки с оценкой и пометкой о совпадениях в сообщении редактору.
      post = postLib.buildPostFor(
        platform,
        { title: news.title, text: r.text, link: news.link, sourceName: news.source },
        { limit: limit - 200 }
      );
    } catch (e) {
      log.rejected(news.link, 'пост не собран: ' + e.message, { relevance: r.relevance });
      return;
    }
    log.drafted(news.link, post.text, { relevance: r.relevance });
    const same = overlapLib.overlap(r.text, news.description, { words: overlapWords });
    const note = overlapLib.overlapNote(same, { max: overlapMax });
    // Бот редактора в Телеграме с разметкой HTML: простой текст для ВКонтакте экранируется,
    // пост для MAX уже в HTML с теми же тегами <b> и <a>.
    const shown = platform === 'vk' ? postLib.escapeHtml(post.text) : post.text;
    const head = `Оценка нейросети: ${r.relevance}/10${post.truncated ? ', текст обрезан' : ''}`;
    out.push({
      json: {
        id: news.id,
        link: news.link,
        relevance: r.relevance,
        text: post.text,
        // Номер повтора отправки редактору, считает узел «Повтор черновика».
        attempt: 0,
        overlap: Math.round(same.ratio * 100) / 100,
        // Редактору видны оценка нейросети и пометка о совпадениях, в канал они не попадают.
        editorText: `${head}${note ? '\n' + note : ''}\n\n${shown}`,
      },
    });
  });
  return out;
} finally {
  db.close();
}
