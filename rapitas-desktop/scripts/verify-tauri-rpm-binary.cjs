const fs = require('node:fs');
const assert = require('node:assert/strict');

/** Reproduce Tauri's one bundle-type patch, then compare every byte. */
function verifyRpmBinary(original, packaged) {
  // https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle.rs
  // Tauri patches UNK -> RPM for packaging and restores the original afterward.
  const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const offset = original.indexOf(marker);
  assert.ok(offset >= 0, 'Original binary has no Tauri bundle type marker');
  assert.equal(original.indexOf(marker, offset + 1), -1, 'Ambiguous Tauri bundle type marker');
  const expected = Buffer.from(original);
  Buffer.from('__TAURI_BUNDLE_TYPE_VAR_RPM').copy(expected, offset);
  assert.ok(
    expected.equals(packaged),
    'RPM binary differs beyond the expected Tauri bundle type patch',
  );
}

if (require.main === module) {
  const [original, packaged] = process.argv.slice(2);
  assert.ok(original && packaged, 'Usage: verify-tauri-rpm-binary.cjs ORIGINAL PACKAGED');
  verifyRpmBinary(fs.readFileSync(original), fs.readFileSync(packaged));
  console.log('RPM app matches the original with exactly the Tauri bundle type patch');
}

module.exports = { verifyRpmBinary };
