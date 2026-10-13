// Узел «Разбор»: ответ нейросети -> части поста (parse.js). Отказ модели, низкая
// оценка и ошибка запроса пишутся в журнал с причиной, дальше идут только годные.
// Телеграм: части поста по prompts/telegram.md; у большой новости готовится
// страница Телеграфа с подробным пересказом (поле telegraph, её создаёт узел «Телеграф»).
// ВКонтакте и MAX: текст поста одним куском, как раньше.
// @include src/filter.js as filterLib
// @include src/log.js as logLib
// @include src/parse.js as parseLib
// @include src/post.js as postLib
// @include src/card.js as cardLib

const { DatabaseSync } = require('node:sqlite');
const settings = $('Настройки').first().json;
const minRelevance = Number(settings.MIN_RELEVANCE ?? 6);
const platform = postLib.platformOf(settings);
const channel = cardLib.channelOf(settings);
// Без ключа Телеграфа подробный пересказ не публикуется, в посте остаётся источник.
const telegraphOn = String(settings.TELEGRAPH ?? 'on').trim().toLowerCase() !== 'off';

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
    const base = {
      draft: true,
      id: news.id,
      link: news.link,
      title: news.title,
      source: news.source,
      description: news.description,
    };
    if (platform === 'telegram') {
      const r = parseLib.parseCardResponse(content, { minRelevance });
      if (!r.ok) {
        log.rejected(news.link, r.reason, { relevance: r.relevance });
        return;
      }
      const card = { ...r.card, image: news.image || '' };
      const telegraph =
        telegraphOn && cardLib.needFull(card, news.article)
          ? cardLib.telegraphPage({ title: card.title, full: card.full, image: card.image, link: news.link, sourceName: news.source, channel })
          : null;
      out.push({ json: { ...base, relevance: r.relevance, text: r.text, card, telegraph }, pairedItem: { item: i } });
      return;
    }
    const r = parseLib.parseModelResponse(content, { minRelevance });
    if (!r.ok) {
      log.rejected(news.link, r.reason, { relevance: r.relevance });
      return;
    }
    out.push({ json: { ...base, relevance: r.relevance, text: r.text, card: null, telegraph: null }, pairedItem: { item: i } });
  });
  return out;
} finally {
  db.close();
}
