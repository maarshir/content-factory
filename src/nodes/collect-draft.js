// Узел «Разбор и пост»: ответ нейросети -> parse.js -> post.js -> черновик в журнал.
// Отказ модели, низкая оценка и ошибка запроса пишутся в журнал с причиной.
// @include src/filter.js as filterLib
// @include src/log.js as logLib
// @include src/parse.js as parseLib
// @include src/post.js as postLib

const { DatabaseSync } = require('node:sqlite');
const settings = $('Настройки').first().json;
const minRelevance = Number(settings.MIN_RELEVANCE ?? 6);

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
      // Запас 64 знака под строку с оценкой в сообщении редактору.
      post = postLib.buildPost(
        { title: news.title, text: r.text, link: news.link, sourceName: news.source },
        { limit: postLib.TELEGRAM_TEXT_LIMIT - 64 }
      );
    } catch (e) {
      log.rejected(news.link, 'пост не собран: ' + e.message, { relevance: r.relevance });
      return;
    }
    log.drafted(news.link, post.text, { relevance: r.relevance });
    out.push({
      json: {
        id: news.id,
        link: news.link,
        relevance: r.relevance,
        text: post.text,
        // Номер повтора отправки редактору, считает узел «Повтор черновика».
        attempt: 0,
        // Редактору видна оценка нейросети, в канал она не попадает.
        editorText: `Оценка нейросети: ${r.relevance}/10${post.truncated ? ', текст обрезан' : ''}\n\n${post.text}`,
      },
    });
  });
  return out;
} finally {
  db.close();
}
