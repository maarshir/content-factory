// Узел «Промпт»: шаблон из prompts/ под площадку PLATFORM из «Настроек» с полями новости.
// telegram (по умолчанию): prompts/telegram.md, vk: prompts/vk.md, max: prompts/max.md.
// На вход приходит страница статьи из узла «Страница»: из неё берутся картинка
// для обложки и текст для подробного пересказа (src/page.js). Страница не скачалась:
// пост пишется по описанию из ленты, картинка из ленты, если она там есть.
// @include src/post.js as postLib
// @include src/page.js as pageLib
// @include prompts/telegram.md as PROMPT_TELEGRAM
// @include prompts/vk.md as PROMPT_VK
// @include prompts/max.md as PROMPT_MAX

const settings = $('Настройки').first().json;
const maxLength = Number(settings.MAX_LENGTH) || 1200;
const platform = postLib.platformOf(settings);
const PROMPT = { telegram: PROMPT_TELEGRAM, vk: PROMPT_VK, max: PROMPT_MAX }[platform];

return $input.all().map((it, i) => {
  const news = $('Отбор').itemMatching(i).json;
  const html = it.json && typeof it.json.html === 'string' ? it.json.html : '';
  const page = pageLib.parsePage(html, news.link);
  return {
    json: {
      ...news,
      image: page.image || news.image || '',
      article: page.text,
      prompt: postLib.fillPrompt(PROMPT, {
        title: news.title,
        description: news.description || '(описания нет)',
        article: page.text || '(текста статьи нет)',
        link: news.link,
        maxLength,
      }),
    },
    pairedItem: { item: i },
  };
});
