const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const docs = path.join(root, 'docs');

// Ссылки Markdown [текст](адрес) и картинки ![текст](адрес), без блоков кода.
function links(text) {
  const plain = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  return [...plain.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
}

const files = [
  path.join(root, 'README.md'),
  ...fs
    .readdirSync(docs)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(docs, f)),
];

for (const file of files) {
  test(`относительные ссылки в ${path.relative(root, file)} ведут на файлы`, () => {
    const broken = [];
    for (const href of links(fs.readFileSync(file, 'utf8'))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue;
      const target = decodeURIComponent(href.split('#')[0].split('?')[0]);
      if (!target) continue;
      if (!fs.existsSync(path.resolve(path.dirname(file), target))) broken.push(href);
    }
    assert.deepStrictEqual(broken, []);
  });
}

test('ссылки находятся в тексте, но не в коде', () => {
  assert.deepStrictEqual(links('[a](x.md) `[b](y.md)` ![c](d.svg)'), ['x.md', 'd.svg']);
});
