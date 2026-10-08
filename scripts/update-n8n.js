#!/usr/bin/env node
// Обновляет код узлов Code в конвейерах, выгруженных из работающего n8n,
// не трогая учётные данные, «Настройки» и остальные узлы.
// Узел находится по заметке «Код: src/nodes/...», код собирается из src/ так же,
// как в npm run build. В выходной файл попадают только изменённые конвейеры.
//
// Запуск: node scripts/update-n8n.js выгрузка.json обновлённые.json
// Выгрузка: n8n export:workflow --all --output=выгрузка.json
// Загрузка: n8n import:workflow --input=обновлённые.json (тот же id, конвейер
// перезаписывается; n8n при импорте выключает конвейер, включить заново).
// Пошагово для сервера: docs/setup.md, раздел «Обновление кода в работающем n8n».
'use strict';

const fs = require('node:fs');
const { buildNodeCode } = require('./build-workflows.js');

const NOTE = /^Код: (src\/nodes\/[\w.-]+\.js)$/m;

function updateWorkflows(list) {
  const out = [];
  const report = [];
  for (const wf of list) {
    let dirty = false;
    for (const node of wf.nodes || []) {
      if (node.type !== 'n8n-nodes-base.code') continue;
      const m = String(node.notes || '').match(NOTE);
      if (!m) continue;
      const code = buildNodeCode(m[1]);
      if (node.parameters && node.parameters.jsCode !== code) {
        node.parameters.jsCode = code;
        report.push(`${wf.name}: ${node.name}`);
        dirty = true;
      }
    }
    if (dirty) out.push(wf);
  }
  return { workflows: out, report };
}

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('Запуск: node scripts/update-n8n.js выгрузка.json обновлённые.json');
    process.exit(2);
  }
  const data = JSON.parse(fs.readFileSync(input, 'utf8'));
  const { workflows, report } = updateWorkflows(Array.isArray(data) ? data : [data]);
  fs.writeFileSync(output, JSON.stringify(workflows, null, 2) + '\n');
  console.log(report.length ? 'Обновлено:\n' + report.join('\n') : 'Код во всех узлах уже совпадает с src/');
}

module.exports = { updateWorkflows };
