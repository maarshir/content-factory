#!/usr/bin/env node
// Вклеивает код из src/nodes/ в узлы Code конвейеров workflows/*.json.
// Узел связан с файлом через заметку узла (notes): «Код: src/nodes/имя.js».
// Строка `// @include путь as ИМЯ` в файле узла заменяется содержимым файла:
//   .js   -> const ИМЯ = (() => { модуль; return module.exports; })();
//   .json -> const ИМЯ = объект;
//   .md и прочее -> const ИМЯ = "текст";
// Запуск: npm run build (пересобрать) или node scripts/build-workflows.js --check
// (только проверить, что вклеенное совпадает с src/; так делает тест).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NOTE = /^Код: (src\/nodes\/[\w.-]+\.js)$/m;
const INCLUDE = /^\/\/ @include ([\w./-]+) as ([A-Za-z_$][\w$]*)\s*$/;

function readRel(rel) {
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT + path.sep)) throw new Error(`путь вне репозитория: ${rel}`);
  return fs.readFileSync(full, 'utf8');
}

function include(rel, name) {
  const text = readRel(rel);
  const head = `// ${rel} (вклеено scripts/build-workflows.js, править в src/)`;
  if (rel.endsWith('.js')) {
    const body = text.replace(/\s+$/, '');
    return `${head}\nconst ${name} = (() => {\n  const module = { exports: {} };\n${body}\n  return module.exports;\n})();`;
  }
  if (rel.endsWith('.json')) return `${head}\nconst ${name} = ${JSON.stringify(JSON.parse(text))};`;
  return `${head}\nconst ${name} = ${JSON.stringify(text.replace(/\s+$/, '') + '\n')};`;
}

// Готовый код узла из файла src/nodes/...
function buildNodeCode(rel) {
  return readRel(rel)
    .split('\n')
    .map((line) => {
      const m = line.match(INCLUDE);
      return m ? include(m[1], m[2]) : line;
    })
    .join('\n')
    .replace(/\s+$/, '') + '\n';
}

function workflowFiles() {
  const dir = path.join(ROOT, 'workflows');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join('workflows', f));
}

// Возвращает список узлов, где код разошёлся с src/. При write = true исправляет файлы.
function build({ write = false } = {}) {
  const changed = [];
  for (const rel of workflowFiles()) {
    const wf = JSON.parse(readRel(rel));
    let dirty = false;
    for (const node of wf.nodes || []) {
      if (node.type !== 'n8n-nodes-base.code') continue;
      const m = String(node.notes || '').match(NOTE);
      if (!m) throw new Error(`${rel}: у узла «${node.name}» нет заметки «Код: src/nodes/...»`);
      const code = buildNodeCode(m[1]);
      if (node.parameters.jsCode !== code) {
        changed.push(`${rel}: ${node.name}`);
        node.parameters.jsCode = code;
        dirty = true;
      }
    }
    if (dirty && write) fs.writeFileSync(path.join(ROOT, rel), JSON.stringify(wf, null, 2) + '\n');
  }
  return changed;
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const changed = build({ write: !check });
  if (check && changed.length) {
    console.error('Код в конвейерах отличается от src/, запустите npm run build:\n' + changed.join('\n'));
    process.exit(1);
  }
  console.log(changed.length ? 'Обновлено:\n' + changed.join('\n') : 'Всё совпадает с src/');
}

module.exports = { build, buildNodeCode };
