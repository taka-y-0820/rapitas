#!/usr/bin/env node
/**
 * Prepare backend binary for Tauri build in CI/CD
 * This script handles the backend binary resource configuration dynamically
 */
const fs = require('fs');
const path = require('path');
const { deduplicateBackendResources } = require('./backend-resource-dedup');

// Get the target from environment or command line
const target = process.env.TARGET || process.argv[2] || 'x86_64-unknown-linux-gnu';
const isWindows = target.includes('windows');
const isMacos = target.includes('apple-darwin');
const isLinux = target.includes('linux');

// Determine the binary name based on target
let binaryName;
if (isWindows) {
  // Windows uses special naming: <name>.exe-<target>.exe
  binaryName = `rapitas-backend.exe-${target}.exe`;
} else if (isMacos) {
  binaryName = `rapitas-backend-${target}`;
} else {
  binaryName = `rapitas-backend-${target}`;
}

// Path to binaries directory
const binariesDir = path.join(__dirname, '..', 'src-tauri', 'binaries');
const binaryPath = path.join(binariesDir, binaryName);

function isUsableBackendBinary(file) {
  if (!file.startsWith('rapitas-backend') || file.includes('placeholder')) {
    return false;
  }

  const stat = fs.statSync(path.join(binariesDir, file));
  return stat.isFile() && stat.size > 0;
}

// Ensure binaries directory exists
if (!fs.existsSync(binariesDir)) {
  fs.mkdirSync(binariesDir, { recursive: true });
  console.log(`Created binaries directory: ${binariesDir}`);
}

// Check if binary exists
if (!fs.existsSync(binaryPath)) {
  console.log(`Backend binary not found: ${binaryPath}`);

  // Check if binaries directory exists before trying to read it
  if (fs.existsSync(binariesDir)) {
    console.log(`Looking for alternatives in ${binariesDir}...`);
    const files = fs.readdirSync(binariesDir);
    console.log('Found files:', files);

    // Try to find any rapitas-backend file
    const backendFile = files.find(isUsableBackendBinary);
    if (backendFile) {
      console.log(`Found alternative: ${backendFile}`);
      // Create a symlink or copy with the expected name
      const alternativePath = path.join(binariesDir, backendFile);
      try {
        fs.copyFileSync(alternativePath, binaryPath);
        console.log(`Copied ${backendFile} to ${binaryName}`);

        // Make sure the file is executable on Unix systems
        if (!isWindows) {
          fs.chmodSync(binaryPath, 0o755);
          console.log(`Made ${binaryName} executable`);
        }
      } catch (e) {
        console.error(`Failed to copy binary: ${e.message}`);
      }
    }
  } else {
    console.log(`Binaries directory does not exist: ${binariesDir}`);
  }
}

// Read the build config
const configPath = path.join(__dirname, '..', 'src-tauri', 'tauri.build.conf.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`Failed to read tauri.build.conf.json: ${e.message}`);
  process.exit(1);
}

// Update resources to include the specific binary file
if (!config.bundle) {
  config.bundle = {};
}

// Use resources instead of externalBin to embed backend in app directory
// This approach hides the backend executable from users
// Verify that at least one backend binary exists
let foundBinary = null;
if (fs.existsSync(binariesDir)) {
  const files = fs.readdirSync(binariesDir);
  foundBinary = files.find(isUsableBackendBinary);

  if (foundBinary) {
    console.log(`Found backend binary: ${foundBinary}`);
  } else {
    console.warn(`Warning: No backend binary found in ${binariesDir}`);

    // In CI/CD, create a placeholder to allow build to proceed
    if (process.env.CI) {
      console.log('CI environment detected - creating placeholder binary');
      const placeholderName = isWindows
        ? 'rapitas-backend-x86_64-pc-windows-msvc.exe'
        : `rapitas-backend-${target}`;
      const placeholderPath = path.join(binariesDir, placeholderName);

      if (!fs.existsSync(binariesDir)) {
        fs.mkdirSync(binariesDir, { recursive: true });
      }

      // Create minimal executable placeholder
      const placeholderContent = isWindows ? '' : '#!/bin/sh\necho "CI placeholder binary"\nexit 0';
      fs.writeFileSync(placeholderPath, placeholderContent);
      if (!isWindows) {
        fs.chmodSync(placeholderPath, 0o755);
      }

      console.log(`Created placeholder binary: ${placeholderPath}`);
      foundBinary = placeholderName;
    } else {
      console.error('No backend binary found and not in CI environment');
      process.exit(1);
    }
  }
}

const candidateFiles = fs
  .readdirSync(binariesDir)
  .filter((file) => {
    return isUsableBackendBinary(file);
  })
  .sort((left, right) => {
    const score = (file) => {
      if (file.includes(target)) return 3;
      if (file === 'rapitas-backend' || file === 'rapitas-backend.exe') return 2;
      return 1;
    };
    return score(right) - score(left) || left.localeCompare(right);
  });

// CI creates generic and target-specific copies of the same large executable.
// Preserve the preferred target filename and all distinct contents; only the
// bundle manifest changes, so build inputs remain available to other steps.
const resourceFiles = deduplicateBackendResources(candidateFiles, binariesDir).map(
  (file) => `binaries/${file}`,
);

if (resourceFiles.length === 0) {
  console.error(`No backend resource files found in ${binariesDir}`);
  process.exit(1);
}

config.bundle.externalBin = [];
config.bundle.resources = resourceFiles;

console.log('Configured backend as resources (embedded in app directory)');
console.log('Resources configuration:', config.bundle.resources);

// Write the updated config
try {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log('Updated tauri.build.conf.json successfully');
} catch (e) {
  console.error(`Failed to write tauri.build.conf.json: ${e.message}`);
  process.exit(1);
}
