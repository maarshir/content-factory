// Узел «Промпт»: шаблон из prompts/ под площадку PLATFORM из «Настроек» с полями новости.
// telegram (по умолчанию): prompts/telegram.md, vk: prompts/vk.md, max: prompts/max.md.
// @include src/post.js as postLib
// @include prompts/telegram.md as PROMPT_TELEGRAM
// @include prompts/vk.md as PROMPT_VK
// @include prompts/max.md as PROMPT_MAX

const settings = $('Настройки').first().json;
const maxLength = Number(settings.MAX_LENGTH) || 1200;
const platform = postLib.platformOf(settings);
const PROMPT = { telegram: PROMPT_TELEGRAM, vk: PROMPT_VK, max: PROMPT_MAX }[platform];

return $input.all().map((it) => ({
  json: {
    ...it.json,
    prompt: postLib.fillPrompt(PROMPT, {
      title: it.json.title,
      description: it.json.description || '(описания нет)',
      link: it.json.link,
      maxLength,
    }),
  },
}));
