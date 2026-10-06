// Повтор отправки в Телеграм при ошибке 429 (Too Many Requests).
// Телеграм отвечает { ok: false, error_code: 429, description: "Too Many Requests: retry after 5",
// parameters: { retry_after: 5 } }. Узел Telegram в n8n отдаёт ошибку по-разному: объектом,
// строкой или только своим текстом без retry_after, поэтому разбор ищет число везде.
'use strict';

const DEFAULTS = {
  maxRetries: 3, // повторов после первой неудачной отправки
  maxWait: 60, // больше ждать нет смысла: запуск сбора раз в 3 часа
  defaultWait: 10, // если retry_after не нашёлся: 10, 20, 30 секунд
};

function textOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// { tooMany, retryAfter, text } из ответа Телеграма или из элемента ошибки узла n8n.
function telegramError(res) {
  const r = res && typeof res === 'object' ? res : { error: res };
  const err = r.error && typeof r.error === 'object' ? r.error : {};
  const all = textOf(r);

  let retryAfter = null;
  for (const v of [r.parameters && r.parameters.retry_after, err.parameters && err.parameters.retry_after]) {
    if (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== null && v !== '') {
      retryAfter = Number(v);
      break;
    }
  }
  if (retryAfter === null) {
    const m = all.match(/retry[ _]after\\?"?\s*[:=]?\s*(\d+)/i);
    if (m) retryAfter = Number(m[1]);
  }

  const code = r.error_code ?? err.error_code ?? err.httpCode ?? err.code ?? r.httpCode;
  const tooMany = String(code) === '429' || /too many requests|\b429\b/i.test(all) || retryAfter !== null;

  const text =
    r.description ||
    err.description ||
    err.message ||
    (typeof r.error === 'string' ? r.error : '') ||
    r.message ||
    (all !== '{}' ? all : '') ||
    'без описания';
  return { tooMany, retryAfter, text: String(text) };
}

// Что делать после неудачной отправки номер attempt (0 для первой).
// { retry: true, wait, attempt } или { retry: false, reason } для журнала.
function planRetry(res, attempt, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const e = telegramError(res);
  const n = Number(attempt);
  if (!e.tooMany) return { retry: false, reason: `черновик не отправлен редактору: ${e.text}` };
  if (!Number.isInteger(n) || n < 0) {
    return { retry: false, reason: 'черновик не отправлен редактору: 429, номер попытки неизвестен' };
  }
  if (n >= o.maxRetries) {
    return { retry: false, reason: `черновик не отправлен редактору: 429 после ${o.maxRetries} повторов` };
  }
  const wait = e.retryAfter !== null ? Math.max(1, e.retryAfter) : o.defaultWait * (n + 1);
  if (wait > o.maxWait) {
    return { retry: false, reason: `черновик не отправлен редактору: 429, ждать ${wait} с` };
  }
  return { retry: true, wait, attempt: n + 1 };
}

// Черновик не дошёл до редактора: причина в журнал (таблица items из log.js) по номеру записи.
// Статус не меняется, запись остаётся collected. Если редактор уже успел решить, журнал не трогается.
// Возвращает true, если запись обновлена.
function markUndelivered(db, id, reason, now = () => new Date().toISOString()) {
  const r = String(reason || '').trim();
  if (!r) throw new Error('нужна причина');
  const res = db
    .prepare("UPDATE items SET reason = ?, updated_at = ? WHERE id = ? AND status = 'collected'")
    .run(r, now(), Number(id));
  return Number(res.changes) > 0;
}

if (typeof module !== 'undefined') {
  module.exports = { DEFAULTS, telegramError, planRetry, markUndelivered };
}
