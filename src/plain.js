// Перевод поста из разметки HTML Телеграма в простой текст для ВКонтакте и выбор текста под площадку.
// Файл без зависимостей: вклеивается в узел Code n8n целиком.
'use strict';

// Черновик из журнала, собранный для Телеграма (HTML), в простой текст для ВКонтакте:
// <b> и прочие теги убираются, ссылка источника переносится на отдельную строку,
// сущности &amp; &lt; &gt; &quot; раскрываются. Текст без тегов возвращается как есть.
function htmlToPlain(html) {
  const s = String(html ?? '');
  if (!/<\/?[a-z][^>]*>/i.test(s)) return s.trim();
  const unescape = (t) =>
    t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return unescape(
    s
      .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => `${text}\n${href}`)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?[a-z][^>]*>/gi, '')
  ).trim();
}

// Черновик собран для Телеграма, если в нём есть теги разметки HTML (buildPost всегда
// ставит <b> и <a>). Пост для ВКонтакте собирается простым текстом без тегов.
// Площадка в журнал не пишется: её видно по самому тексту, и переписанный по кнопке
// черновик (он всегда в HTML) определяется так же.
function isTelegramPost(text) {
  return /<\/?[a-z][^>]*>/i.test(String(text ?? ''));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Текст поста для отправки на площадку platform из черновика журнала.
// vk: черновик Телеграма переводится в простой текст, пост ВКонтакте уходит как есть.
// telegram: пост ВКонтакте экранируется под parse_mode HTML, черновик Телеграма как есть.
function textFor(platform, post) {
  const telegram = isTelegramPost(post);
  if (platform === 'vk') return telegram ? htmlToPlain(post) : String(post ?? '').trim();
  return telegram ? String(post) : escapeHtml(String(post ?? '').trim());
}

if (typeof module !== 'undefined') module.exports = { htmlToPlain, isTelegramPost, textFor };
