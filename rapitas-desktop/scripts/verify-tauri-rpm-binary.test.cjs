const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyRpmBinary } = require('./verify-tauri-rpm-binary.cjs');
const original = Buffer.from('prefix\0__TAURI_BUNDLE_TYPE_VAR_UNK\0suffix');
const rpm = Buffer.from('prefix\0__TAURI_BUNDLE_TYPE_VAR_RPM\0suffix');

test('accepts exactly the packaging patch without mutating inputs', () => {
  const before = Buffer.from(original);
  verifyRpmBinary(original, rpm);
  assert.deepEqual(original, before);
});

test('rejects wrong format, unpatched payload, truncation, and unrelated corruption', () => {
  for (const payload of [
    original,
    Buffer.from(rpm.toString().replace('_RPM', '_DEB')),
    rpm.subarray(0, rpm.length - 1),
    Buffer.concat([rpm, Buffer.from('x')]),
    Buffer.from(rpm.toString().replace('suffix', 'broken')),
  ])
    assert.throws(() => verifyRpmBinary(original, payload));
});

test('fails closed when the original marker is missing or ambiguous', () => {
  assert.throws(() => verifyRpmBinary(rpm, rpm));
  assert.throws(() =>
    verifyRpmBinary(Buffer.concat([original, original]), Buffer.concat([rpm, rpm])),
  );
});
