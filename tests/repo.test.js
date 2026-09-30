const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('в .env.example ключи не заполнены', () => {
  const secret = /(KEY|TOKEN|SECRET|PASSWORD)$/;
  for (const line of read('.env.example').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && secret.test(m[1])) assert.strictEqual(m[2].trim(), '', `${m[1]} должен быть пустым`);
  }
});

test('.env и базы не попадают в репозиторий', () => {
  const lines = read('.gitignore').split('\n').map((s) => s.trim());
  assert.ok(lines.includes('.env'));
  assert.ok(lines.includes('*.sqlite'));
});

test('папки проекта на месте', () => {
  for (const d of ['src', 'tests', 'prompts', 'workflows', 'docs']) {
    assert.ok(fs.statSync(path.join(root, d)).isDirectory(), d);
  }
});
