const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const compose = read('docker-compose.yml');
const envNames = new Set(
  read('.env.example')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=/))
    .filter(Boolean)
    .map((m) => m[1]),
);

test('образ n8n закреплён на версии', () => {
  const m = compose.match(/image:\s*(\S+)/);
  assert.ok(m, 'нет image');
  assert.match(m[1], /n8nio\/n8n:\d+\.\d+\.\d+$/);
});

test('все переменные из compose есть в .env.example', () => {
  const used = [...compose.matchAll(/\$\{([A-Z0-9_]+)(?:[:-][^}]*)?\}/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const name of used) assert.ok(envNames.has(name), `${name} нет в .env.example`);
});

test('в compose нет вшитых секретов', () => {
  const secret = /(KEY|TOKEN|SECRET|PASSWORD)/;
  for (const line of compose.split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*-?\s*([A-Z0-9_]+)\s*[:=]\s*(.*)$/);
    if (m && secret.test(m[1])) {
      assert.match(m[2].trim(), /^"?\$\{[A-Z0-9_]+\}"?$/, `${m[1]} должен браться из .env`);
    }
  }
  assert.doesNotMatch(compose, /gsk_[A-Za-z0-9]{10,}|\b\d{6,}:[A-Za-z0-9_-]{30,}/, 'похоже на ключ Groq или токен бота');
});

test('узлам Code открыт только node:sqlite, доступ к окружению не открыт', () => {
  const m = compose.match(/NODE_FUNCTION_ALLOW_BUILTIN:\s*"?([^"\n]+)"?/);
  assert.ok(m);
  assert.strictEqual(m[1].trim(), 'node:sqlite');
  assert.doesNotMatch(compose, /NODE_FUNCTION_ALLOW_EXTERNAL/);
  assert.doesNotMatch(compose, /N8N_BLOCK_ENV_ACCESS_IN_NODE/);
});

test('данные n8n в томе, порт только на localhost', () => {
  assert.match(compose, /\/home\/node\/\.n8n/);
  assert.match(compose, /"127\.0\.0\.1:5678:5678"/);
});

test('.env.example описывает переменные для конвейеров', () => {
  for (const name of ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ID', 'EDITOR_CHAT_ID', 'CF_DB_PATH']) {
    assert.ok(envNames.has(name), name);
  }
});
