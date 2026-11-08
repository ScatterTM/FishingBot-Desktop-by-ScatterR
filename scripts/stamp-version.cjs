'use strict';

// The one place the release version is set: the VERSION file in the project root (for example 1.0.4-beta).
// This script writes it into everything that carries it:
//   package.json, package-lock.json, desktop-electron/package.json  (the app's version, shown in the app)
//   installer-gui/ReleaseInfo.g.cs                                   (the installer's version)
// build.bat, build-desktop.bat and build-setup.bat run it, so a build cannot ship an old version number.
//
//   node scripts/stamp-version.cjs                     stamp all files
//   node scripts/stamp-version.cjs --installer-name    print the installer file name, e.g. Fishingbot_Setup_v1.0.4-beta.exe

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
// build-1.0.5-beta.bat sets FISHINGBOT_VERSION from its own file name. That value wins, and it is written
// to the VERSION file so the project records the version it was last built as.
const override = (process.env.FISHINGBOT_VERSION || '').trim();
const raw = override || fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const match = /^(\d+)\.(\d+)\.(\d+)(-beta)?$/.exec(raw);
if (!match) {
  console.error(`The version must look like 1.0.5-beta or 1.0.5 (found "${raw}").`);
  process.exit(1);
}
if (override && !process.argv.includes('--installer-name')) {
  fs.writeFileSync(path.join(root, 'VERSION'), raw + '\n');
}

const version = raw;                                   // 1.0.4-beta (npm and the app)
const number = `${match[1]}.${match[2]}.${match[3]}`;  // 1.0.4 (numeric comparisons)
const label = match[4] ? `${number} Beta` : number;    // "1.0.4 Beta" (shown to people)
const installerName = `Fishingbot_Setup_v${version}.exe`;

if (process.argv.includes('--installer-name')) {
  process.stdout.write(installerName);
  process.exit(0);
}

function stampJson(file, withDescription) {
  const abs = path.join(root, file);
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  data.version = version;
  if (data.packages && data.packages['']) data.packages[''].version = version;
  if (withDescription && typeof data.description === 'string') {
    data.description = data.description.replace(/Fishingbot v\S+( Beta)?/, `Fishingbot v${label}`);
  }
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
}

stampJson('package.json', true);
stampJson('package-lock.json', false);
stampJson(path.join('desktop-electron', 'package.json'), false);

fs.writeFileSync(
  path.join(root, 'installer-gui', 'ReleaseInfo.g.cs'),
  [
    '// Generated from the VERSION file by scripts/stamp-version.cjs. Do not edit: change VERSION instead.',
    'internal static class ReleaseInfo',
    '{',
    `    public const string Number = "${number}";`,
    `    public const string Label = "${label}";`,
    '}',
    '',
  ].join('\n'),
);

console.log(`Version ${version} (${label}). Installer: ${installerName}`);
