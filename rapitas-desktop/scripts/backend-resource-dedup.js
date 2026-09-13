/** Keep the first (preferred) filename for byte-identical backend resources. */
const fs = require('node:fs');
const path = require('node:path');

function identicalFiles(left, right, size) {
  const leftFd = fs.openSync(left, 'r');
  let rightFd;
  try {
    rightFd = fs.openSync(right, 'r');
    const a = Buffer.alloc(1024 * 1024);
    const b = Buffer.alloc(a.length);
    for (let offset = 0; offset < size; ) {
      const length = Math.min(a.length, size - offset);
      const readA = fs.readSync(leftFd, a, 0, length, offset);
      const readB = fs.readSync(rightFd, b, 0, length, offset);
      // Short reads or concurrent truncation must never discard a resource.
      if (
        readA !== length ||
        readB !== length ||
        !a.subarray(0, length).equals(b.subarray(0, length))
      )
        return false;
      offset += length;
    }
    return fs.fstatSync(leftFd).size === size && fs.fstatSync(rightFd).size === size;
  } finally {
    fs.closeSync(leftFd);
    if (rightFd !== undefined) fs.closeSync(rightFd);
  }
}

function deduplicateBackendResources(files, directory) {
  const kept = [];
  for (const file of files) {
    const filename = path.join(directory, file);
    const size = fs.statSync(filename).size;
    if (
      !kept.some((entry) => entry.size === size && identicalFiles(entry.filename, filename, size))
    ) {
      kept.push({ file, filename, size });
    }
  }
  return kept.map((entry) => entry.file);
}

module.exports = { deduplicateBackendResources };
