// index.html preloads every JavaScript module (faster first load); a new module must be added there too.
//   node --test frontend/tests/modules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modules = [...readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`),
  ...readdirSync(join(root, 'js/pages')).filter((f) => f.endsWith('.js')).map((f) => `js/pages/${f}`)];

test('index.html preloads every module', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  for (const m of modules) assert.ok(html.includes(`<link rel="modulepreload" href="${m}" />`), `missing modulepreload for ${m}`);
});

test('every module parses as an ES module (a syntax error blanks the whole page)', async () => {
  const { spawnSync } = await import('node:child_process');
  for (const m of modules) {
    const r = spawnSync(process.execPath, ['--experimental-default-type=module', '--check', join(root, m)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${m}: ${r.stderr.split('\n').slice(0, 4).join('\n')}`);
  }
});
