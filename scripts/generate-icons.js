#!/usr/bin/env node
/**
 * Generate icon16.png, icon48.png, icon128.png from icons/logo-small.jpg.
 * Uses macOS sips (Scriptable Image Processing System). Run from repo root:
 *   node scripts/generate-icons.js
 * Requires: logo-small.jpg in the icons directory.
 */
const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');

const ICONS_DIR = path.join(__dirname, '..', 'icons');
const SOURCE = path.join(ICONS_DIR, 'logo-small.jpg');

if (!fs.existsSync(SOURCE)) {
  console.error('Source not found:', SOURCE);
  process.exit(1);
}

for (const size of [16, 48, 128]) {
  const out = path.join(ICONS_DIR, `icon${size}.png`);
  execSync(`sips -z ${size} ${size} "${SOURCE}" -s format png -o "${out}"`, {
    stdio: 'inherit',
  });
  console.log('Wrote', out);
}
