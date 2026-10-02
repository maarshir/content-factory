// Узел «Промпт»: шаблон prompts/telegram.md с полями новости.
// @include src/post.js as postLib
// @include prompts/telegram.md as PROMPT

const settings = $('Настройки').first().json;
const maxLength = Number(settings.MAX_LENGTH) || 1200;

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
