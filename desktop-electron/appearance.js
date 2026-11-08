'use strict';

// Custom wallpaper files for the desktop. The image is copied into data/appearance/ so the
// original file can be moved or deleted, and it is checked by its content, not only by its name.
// The renderer gets the image as a data URL, so the desktop page never reads files from disk itself.

const fs = require('node:fs');
const path = require('node:path');
const settings = require('./settings');

const MAX_BYTES = 15 * 1024 * 1024;
const EXTENSION_BY_TYPE = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
});

function appearanceDir(root) {
  return path.join(root, 'data', 'appearance');
}

// Recognises the four supported formats from their first bytes. Returns the MIME type or null.
function sniff(bytes) {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6) {
    const head = bytes.toString('latin1', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function removeStoredFile(root, name) {
  if (!name || !settings.WALLPAPER_FILE.test(name)) return;
  try {
    fs.rmSync(path.join(appearanceDir(root), name), { force: true });
  } catch {
    /* an old file that cannot be removed is harmless */
  }
}

// Copies the picked image into the data folder and points the settings at it.
// Throws a readable error when the file is not a usable image.
function storeWallpaper(root, sourcePath) {
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) throw new Error('Choose an image file.');
  if (stat.size > MAX_BYTES) throw new Error('That image is larger than 15 MB. Choose a smaller image.');

  const bytes = fs.readFileSync(sourcePath);
  const type = sniff(bytes);
  if (!type) throw new Error('That file is not a PNG, JPEG, WebP or GIF image.');

  const name = `wallpaper-${Date.now()}.${EXTENSION_BY_TYPE[type]}`;
  const dir = appearanceDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, target);

  const previous = settings.view(root).appearance.wallpaperFile;
  settings.write(root, { appearance: { wallpaperFile: name } });
  if (previous && previous !== name) removeStoredFile(root, previous);
  return name;
}

// Goes back to the built-in wallpaper and removes the copied image.
function removeWallpaper(root) {
  const previous = settings.view(root).appearance.wallpaperFile;
  settings.write(root, { appearance: { wallpaperFile: null } });
  removeStoredFile(root, previous);
}

// Returns { name, dataUrl } for the stored wallpaper, or null when the built-in one is used
// (or the stored file is missing or is not an image).
function readWallpaper(root) {
  const name = settings.view(root).appearance.wallpaperFile;
  if (!name) return null;
  try {
    const bytes = fs.readFileSync(path.join(appearanceDir(root), name));
    const type = sniff(bytes);
    if (!type) return null;
    return { name, dataUrl: `data:${type};base64,${bytes.toString('base64')}` };
  } catch {
    return null;
  }
}

// The profile picture: a square image, 512 x 512 px is the best size. Stored in the same folder.
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

function storeAvatar(root, sourcePath) {
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) throw new Error('Choose an image file.');
  if (stat.size > AVATAR_MAX_BYTES) throw new Error('That picture is larger than 5 MB. Choose a smaller image.');
  const bytes = fs.readFileSync(sourcePath);
  const type = sniff(bytes);
  if (!type) throw new Error('That file is not a PNG, JPEG, WebP or GIF image.');
  const name = `avatar-${Date.now()}.${EXTENSION_BY_TYPE[type]}`;
  const dir = appearanceDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, target);
  const previous = settings.view(root).appearance.avatarFile;
  settings.write(root, { appearance: { avatarFile: name } });
  if (previous && previous !== name && settings.AVATAR_FILE.test(previous)) {
    try { fs.rmSync(path.join(dir, previous), { force: true }); } catch { /* harmless */ }
  }
  return name;
}

function removeAvatar(root) {
  const previous = settings.view(root).appearance.avatarFile;
  settings.write(root, { appearance: { avatarFile: null } });
  if (previous && settings.AVATAR_FILE.test(previous)) {
    try { fs.rmSync(path.join(appearanceDir(root), previous), { force: true }); } catch { /* harmless */ }
  }
}

// { name, dataUrl } for the stored profile picture, or null when the letter is used.
function readAvatar(root) {
  const name = settings.view(root).appearance.avatarFile;
  if (!name || !settings.AVATAR_FILE.test(name)) return null;
  try {
    const bytes = fs.readFileSync(path.join(appearanceDir(root), name));
    const type = sniff(bytes);
    if (!type) return null;
    return { name, dataUrl: `data:${type};base64,${bytes.toString('base64')}` };
  } catch {
    return null;
  }
}

module.exports = {
  MAX_BYTES, AVATAR_MAX_BYTES, sniff, storeWallpaper, removeWallpaper, readWallpaper, storeAvatar, removeAvatar, readAvatar,
};
