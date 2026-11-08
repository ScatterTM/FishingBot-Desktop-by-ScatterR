'use strict';

// Writes the Fishingbot icon into the built EXE. Called by build-desktop.bat after electron-builder.
// Usage: node set-icon.js <exe> <ico>
// rcedit is a Node library (a dev dependency), so it is called from here, not through npx.

const fs = require('node:fs');
const path = require('node:path');
const rcedit = require('rcedit');

async function main() {
  const [exe, ico] = process.argv.slice(2);
  if (!exe || !ico) throw new Error('Usage: node set-icon.js <exe> <ico>');
  for (const file of [exe, ico]) {
    if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  }
  // The version strings name the program in Task Manager and Explorer. Without them Windows shows "Electron".
  await rcedit(path.resolve(exe), {
    icon: path.resolve(ico),
    'version-string': {
      CompanyName: 'Fishingbot',
      FileDescription: 'Fishingbot Desktop',
      ProductName: 'Fishingbot Desktop',
      InternalName: 'Fishingbot',
      OriginalFilename: path.basename(exe),
    },
  });
  console.log(`Icon set on ${exe}.`);
}

main().catch((err) => {
  console.error(`Could not set the icon: ${err.message}`);
  process.exit(1);
});
