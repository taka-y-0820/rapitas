const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { deduplicateBackendResources } = require('./backend-resource-dedup');

function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'rapitas-resource-dedup-');
  const directory = fs.mkdtempSync(prefix);
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('retains preferred name, distinct same-size contents and different sizes without deleting inputs', (t) => {
  const directory = fixture(t);
  const files = { target: 'abcd', generic: 'abcd', other: 'abce', shorter: 'abc' };
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(directory, name), content);
  assert.deepEqual(deduplicateBackendResources(Object.keys(files), directory), [
    'target',
    'other',
    'shorter',
  ]);
  assert.deepEqual(fs.readdirSync(directory).sort(), Object.keys(files).sort());
});

test('compares beyond chunk boundaries and propagates missing input errors', (t) => {
  const directory = fixture(t);
  const content = Buffer.alloc(1024 * 1024 + 17, 1);
  fs.writeFileSync(path.join(directory, 'target'), content);
  fs.writeFileSync(path.join(directory, 'same'), content);
  content[content.length - 1] = 2;
  fs.writeFileSync(path.join(directory, 'different'), content);
  assert.deepEqual(deduplicateBackendResources(['target', 'same', 'different'], directory), [
    'target',
    'different',
  ]);
  assert.throws(() => deduplicateBackendResources(['missing'], directory), { code: 'ENOENT' });
});

for (const target of [
  'x86_64-unknown-linux-gnu',
  'aarch64-apple-darwin',
  'x86_64-pc-windows-msvc',
]) {
  test(`prepare script bundles one identical backend for ${target}`, (t) => {
    const directory = fixture(t);
    const scripts = path.join(directory, 'scripts');
    const tauri = path.join(directory, 'src-tauri');
    const binaries = path.join(tauri, 'binaries');
    fs.mkdirSync(scripts);
    fs.mkdirSync(binaries, { recursive: true });
    for (const file of ['prepare-backend-binary.js', 'backend-resource-dedup.js']) {
      fs.copyFileSync(path.join(__dirname, file), path.join(scripts, file));
    }
    const windows = target.includes('windows');
    const preferred = windows ? `rapitas-backend.exe-${target}.exe` : `rapitas-backend-${target}`;
    const generic = windows ? 'rapitas-backend.exe' : 'rapitas-backend';
    fs.writeFileSync(path.join(binaries, preferred), 'same executable');
    fs.writeFileSync(path.join(binaries, generic), 'same executable');
    fs.writeFileSync(
      path.join(tauri, 'tauri.build.conf.json'),
      JSON.stringify({ bundle: { active: true } }),
    );
    execFileSync(process.execPath, [path.join(scripts, 'prepare-backend-binary.js'), target], {
      env: { ...process.env, TARGET: target },
    });
    const config = JSON.parse(fs.readFileSync(path.join(tauri, 'tauri.build.conf.json'), 'utf8'));
    assert.deepEqual(config.bundle.resources, [`binaries/${preferred}`]);
    assert.equal(config.bundle.active, true);
    assert.equal(fs.readFileSync(path.join(binaries, generic), 'utf8'), 'same executable');
  });
}
