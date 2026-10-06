// Узел «Повтор черновика»: ошибки узла «Черновик редактору» (выход ошибок).
// 429: черновик уходит в «Паузу» на retry_after секунд и обратно на отправку, до 3 повторов.
// Иначе причина пишется в журнал, запись остаётся collected, сбор идёт дальше.
// @include src/retry.js as retryLib

const { DatabaseSync } = require('node:sqlite');
const settings = $('Настройки').first().json;

const db = new DatabaseSync(settings.CF_DB_PATH);
try {
  const out = [];
  $input.all().forEach((it, i) => {
    let draft = it.json || {};
    // n8n кладёт в элемент ошибки входные поля; если их нет, черновик берётся по связи элементов.
    // Без номера попытки повтора нет, чтобы не уйти в бесконечный круг.
    if (draft.id === undefined) {
      try {
        draft = { ...$('Разбор и пост').itemMatching(i).json, attempt: undefined };
      } catch {
        return;
      }
    }
    // Только поля ошибки: в тексте новости тоже может встретиться «429».
    const e = {};
    for (const k of ['error', 'error_code', 'description', 'parameters', 'httpCode']) {
      if (it.json && it.json[k] !== undefined) e[k] = it.json[k];
    }
    const plan = retryLib.planRetry(e, draft.attempt);
    if (plan.retry) {
      out.push({
        json: {
          id: draft.id,
          link: draft.link,
          relevance: draft.relevance,
          text: draft.text,
          editorText: draft.editorText,
          attempt: plan.attempt,
          wait: plan.wait,
        },
        pairedItem: { item: i },
      });
      return;
    }
    retryLib.markUndelivered(db, draft.id, plan.reason);
  });
  return out;
} finally {
  db.close();
}
