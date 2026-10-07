// Узел «Промпт»: шаблон из prompts/ под площадку PLATFORM из «Настроек» с полями новости.
// telegram (по умолчанию): prompts/telegram.md, vk: prompts/vk.md.
// @include src/post.js as postLib
// @include prompts/telegram.md as PROMPT_TELEGRAM
// @include prompts/vk.md as PROMPT_VK

const settings = $('Настройки').first().json;
const maxLength = Number(settings.MAX_LENGTH) || 1200;
const platform = postLib.platformOf(settings);
const PROMPT = platform === 'vk' ? PROMPT_VK : PROMPT_TELEGRAM;

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
