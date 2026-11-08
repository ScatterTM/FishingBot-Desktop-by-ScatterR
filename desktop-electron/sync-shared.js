'use strict';

// Copies the Control Centre files that the offline windows need from the website folders
// (styles/ and scripts/, which the server and the installer ship). The copies go to
// renderer/loot/ and are packed into the desktop app. Run before every desktop build.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'renderer', 'loot');
const FILES = [
  ['styles/control-centre.css', 'control-centre.css'],
  ['scripts/control-centre-loot.js', 'loot-editor.js'],
  ['styles/loot-table.css', 'loot-table.css'],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [from, to] of FILES) {
  const source = path.join(ROOT, from);
  if (!fs.existsSync(source)) {
    console.error(`Missing ${from}. Run this from the Fishingbot project folder.`);
    process.exit(1);
  }
  fs.copyFileSync(source, path.join(OUT, to));
}
console.log('Shared Control Centre files copied for the offline windows.');
