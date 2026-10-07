// Проверка пересказа на дословные совпадения с описанием из ленты.
// Файл без зависимостей: вклеивается в узел Code n8n целиком.
//
// Текст режется на слова, из слов собираются цепочки по N подряд (по умолчанию 5).
// Доля совпадений: сколько цепочек поста встречается в описании. Пересказ своими словами
// даёт почти ноль, переписанный абзац с заменой пары слов даёт заметную долю.
'use strict';

const DEFAULT_WORDS = 5;
const DEFAULT_MAX = 0.2;

// Слова в нижнем регистре, ё как е; знаки препинания и разметка не считаются.
function words(text) {
  const plain = String(text ?? '').replace(/<[^>]*>/g, ' ').toLowerCase().replace(/ё/g, 'е');
  return plain.match(/[\p{L}\p{N}]+/gu) || [];
}

function chains(list, n) {
  const out = [];
  for (let i = 0; i + n <= list.length; i++) out.push(list.slice(i, i + n).join(' '));
  return out;
}

// Сравнивает пост с источником. Возвращает
// { ratio, matched, total, fragment }: долю цепочек поста, найденных в источнике (0..1),
// их число, число цепочек поста и самый длинный общий кусок (слова через пробел).
function overlap(post, source, options = {}) {
  const n = Math.max(2, Math.floor(Number(options.words) || DEFAULT_WORDS));
  const p = words(post);
  const s = words(source);
  const postChains = chains(p, n);
  if (postChains.length === 0 || s.length < n) {
    return { ratio: 0, matched: 0, total: postChains.length, fragment: '' };
  }
  const known = new Set(chains(s, n));
  const hit = postChains.map((c) => known.has(c));
  const matched = hit.filter(Boolean).length;

  // Самый длинный кусок: подряд идущие совпавшие цепочки покрывают (k + n - 1) слов.
  let best = 0;
  let bestEnd = -1;
  let run = 0;
  hit.forEach((h, i) => {
    run = h ? run + 1 : 0;
    if (run > best) {
      best = run;
      bestEnd = i;
    }
  });
  const fragment = best ? p.slice(bestEnd - best + 1, bestEnd + n).join(' ') : '';
  return { ratio: matched / postChains.length, matched, total: postChains.length, fragment };
}

// Строка для редактора, если доля выше порога, иначе пустая строка.
// Фрагмент обрезается, чтобы строка не раздувала сообщение.
function overlapNote(result, options = {}) {
  const max = Number.isFinite(Number(options.max)) && options.max !== '' && options.max !== null
    ? Number(options.max)
    : DEFAULT_MAX;
  if (!result || result.total === 0 || result.ratio <= max) return '';
  const pct = (x) => `${Math.round(x * 100)}%`;
  let frag = result.fragment;
  if (frag.length > 60) frag = frag.slice(0, 59).trimEnd() + '…';
  return `Дословно из источника: ${pct(result.ratio)} (порог ${pct(max)}), например «${frag}»`;
}

if (typeof module !== 'undefined') {
  module.exports = { DEFAULT_WORDS, DEFAULT_MAX, words, overlap, overlapNote };
}
