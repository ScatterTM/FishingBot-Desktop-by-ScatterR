'use strict';

// Offline Game settings: the form layout, the limits and the payload for the change queue.
// Limits and option lists are copied from local/manager.js (saveGameplaySettings) and
// lib/chat-settings.js, so bad input is rejected here at once. The server checks again
// when it applies the queue.

const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_FILE = (root) => path.join(root, 'data', 'game-settings-snapshot.json');

const CHAT_OPTIONS = Object.freeze({
  chatDetail: ['full', 'short', 'off'],
  cooldownReply: ['reply', 'silent'],
  rareAnnounceTier: ['off', 'rare', 'epic', 'legendary'],
});

// [key, label, min, max, step]. Same order and labels as the Control Centre page.
const AUTO_GROUPS = Object.freeze([
  {
    title: 'Progression and XP',
    fields: [
      ['maxLevel', 'Maximum Auto-Fish level', 1, 50, 1],
      ['xpPerLevel', 'XP required per level', 1, 10000, 1],
      ['manualXp', 'XP per manual catch', 0, 10000, 1],
      ['autoXp', 'XP per Auto-Fish catch', 0, 10000, 1],
      ['activeEventXp', 'XP per event catch', 0, 10000, 1],
      ['levelEfficiencyStart', 'Starting efficiency (%)', 1, 99, 1],
      ['levelEfficiencyStep', 'Efficiency gained per level (%)', 0, 20, 1],
      ['prestigeMax', 'Maximum prestige level', 0, 5, 1],
    ],
  },
  {
    title: 'License and session timing',
    fields: [
      ['licenseCost', 'Auto-Fish license cost (Treasury)', 0, 100000, 1],
      ['baseIntervalSeconds', 'Base Auto-Fish interval (seconds)', 30, 3600, 1],
      ['sessionMinutesStart', 'Starting session (minutes)', 1, 1440, 1],
      ['sessionMinutesPerLevel', 'Extra minutes per level', 0, 120, 1],
      ['sessionMinutesPerPrestige', 'Extra minutes per prestige', 0, 240, 1],
    ],
  },
  {
    title: 'Fishy treat and event settings',
    fields: [
      ['attentionBase', 'Base treat slots', 1, 20, 1],
      ['attentionEveryLevels', 'Levels per extra treat slot', 1, 10, 1],
      ['attentionPerPrestige', 'Extra treat slots per prestige', 0, 5, 1],
      ['eventChancePercent', 'Treasury event chance (%)', 0, 100, 0.1],
      ['eventDurationSeconds', 'Event duration (seconds)', 10, 300, 1],
      ['eventCooldownSeconds', 'Event cooldown (seconds)', 0, 3600, 1],
    ],
  },
]);

function readSnapshot(root) {
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE(root), 'utf8'));
    return data && typeof data === 'object' && data.autoFish && data.areas ? data : null;
  } catch {
    return null;
  }
}

// values: { cooldownSeconds, chat: {...}, autoFish: {enabled, <fields>}, areas: {enabled, doubleCatchEnabled, items: {id: bool}} }
// Returns an error message, or null when the values are acceptable.
function validate(values) {
  if (!values || typeof values !== 'object') return 'Missing settings.';
  const cooldown = Number(values.cooldownSeconds);
  if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 240) {
    return 'Global cooldown must be a whole number from 0 to 240 seconds.';
  }
  for (const [key, options] of Object.entries(CHAT_OPTIONS)) {
    if (!options.includes(values.chat?.[key])) return `Invalid value for ${key}.`;
  }
  for (const group of AUTO_GROUPS) {
    for (const [key, , min, max] of group.fields) {
      const value = Number(values.autoFish?.[key]);
      if (!Number.isFinite(value) || value < min || value > max) {
        return `${key} must be between ${min} and ${max}.`;
      }
    }
  }
  if (typeof values.areas?.enabled !== 'boolean' || typeof values.areas?.doubleCatchEnabled !== 'boolean') {
    return 'World-feature settings are incomplete.';
  }
  if (!values.areas.items || typeof values.areas.items !== 'object') return 'World-feature settings are incomplete.';
  for (const [id, on] of Object.entries(values.areas.items)) {
    if (typeof on !== 'boolean') return `Missing enabled/disabled state for ${id}.`;
  }
  return null;
}

// Builds the payload that local/manager.js saveGameplaySettings expects.
function toPayload(values) {
  const autoFish = { enabled: values.autoFish.enabled === true };
  for (const group of AUTO_GROUPS) {
    for (const [key] of group.fields) {
      autoFish[key] = Number(values.autoFish[key]);
    }
  }
  return {
    cooldownSeconds: Number(values.cooldownSeconds),
    chat: { ...values.chat },
    autoFish,
    areas: {
      enabled: values.areas.enabled,
      doubleCatchEnabled: values.areas.doubleCatchEnabled,
      items: { ...values.areas.items },
    },
  };
}

// English strings for the offline loot window (same keys as i18n/en.json in the project).
function readStrings(root) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'en.json'), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

// Shape check only. The server checks the rest (names, odds, perks) when it applies the queue.
function validateLoot(payload) {
  if (!payload || typeof payload !== 'object') return 'Missing loot table.';
  if (!Array.isArray(payload.tiers) || payload.tiers.length === 0) return 'The loot table is missing its rarity groups.';
  if (!payload.weights || typeof payload.weights !== 'object') return 'The loot table is missing its weights.';
  if (!payload.abilities || typeof payload.abilities !== 'object') return 'The loot table is missing its perks.';
  if (!payload.areas || typeof payload.areas !== 'object') return 'The loot table is missing its area loot.';
  return null;
}

module.exports = { CHAT_OPTIONS, AUTO_GROUPS, readSnapshot, readStrings, validate, toPayload, validateLoot };
