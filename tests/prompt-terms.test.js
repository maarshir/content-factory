const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROMPTS = ['telegram.md', 'vk.md', 'max.md', 'rewrite.md', 'rewrite-telegram.md'];

for (const name of PROMPTS) {
  test(`${name}: «ИИ» вместо «AI», латиница только в названиях`, () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'prompts', name), 'utf8');
    const rule = text.split('\n').find((line) => line.startsWith('- Писать «ИИ», а не «AI»'));
    assert.ok(rule, 'нет правила о «ИИ»');
    assert.match(rule, /Латиница только в названиях продуктов, компаний и моделей/);
    const rulesStart = text.indexOf('Правила текста:');
    const jsonStart = text.indexOf('Ответь одним объектом JSON');
    const at = text.indexOf(rule);
    assert.ok(rulesStart < at && at < jsonStart, 'правило не в разделе «Правила текста»');
  });
}

test('правило о «ИИ» вклеено в конвейеры сбора и бота редактора', () => {
  for (const wf of ['collect.json', 'editor.json']) {
    const json = fs.readFileSync(path.join(__dirname, '..', 'workflows', wf), 'utf8');
    assert.ok(json.includes('Писать «ИИ», а не «AI»'), `${wf} не пересобран`);
  }
});
