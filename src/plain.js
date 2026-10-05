// Перевод поста из разметки HTML Телеграма в простой текст для ВКонтакте.
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

if (typeof module !== 'undefined') module.exports = { htmlToPlain };
