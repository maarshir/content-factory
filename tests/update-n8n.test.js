'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { updateWorkflows } = require('../scripts/update-n8n.js');
const collect = require('../workflows/collect.json');

function exported() {
  const wf = JSON.parse(JSON.stringify(collect));
  wf.id = 'abc123';
  for (const node of wf.nodes) {
    if (node.name === 'Разбор и пост') node.parameters.jsCode = '// старый код';
    if (node.name === 'Настройки') node.parameters.marker = 'настроено руками';
    if (node.type === 'n8n-nodes-base.telegram') node.credentials = { telegramApi: { id: '7', name: 'Редактор канала' } };
  }
  return wf;
}

test('обновляет только код узлов, учётные данные и настройки остаются', () => {
  // Чужой конвейер с такой же заметкой у узла не трогается, даже если файла нет.
  const other = {
    name: 'job-radar: поиск',
    nodes: [{ name: 'Ленты', type: 'n8n-nodes-base.code', notes: 'Код: src/nodes/sources.js', parameters: { jsCode: 'x' } }],
  };
  const { workflows, report } = updateWorkflows([exported(), other]);
  assert.strictEqual(workflows.length, 1);
  assert.deepStrictEqual(report, ['content-factory: сбор: Разбор и пост']);
  const wf = workflows[0];
  assert.strictEqual(wf.id, 'abc123');
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const fresh = Object.fromEntries(collect.nodes.map((n) => [n.name, n]));
  assert.strictEqual(byName['Разбор и пост'].parameters.jsCode, fresh['Разбор и пост'].parameters.jsCode);
  assert.strictEqual(byName['Настройки'].parameters.marker, 'настроено руками');
  const tg = wf.nodes.find((n) => n.type === 'n8n-nodes-base.telegram');
  assert.deepStrictEqual(tg.credentials, { telegramApi: { id: '7', name: 'Редактор канала' } });
});

test('если код уже совпадает, обновлять нечего', () => {
  const { workflows, report } = updateWorkflows([JSON.parse(JSON.stringify(collect))]);
  assert.strictEqual(workflows.length, 0);
  assert.strictEqual(report.length, 0);
});
