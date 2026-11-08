'use strict';

// Control Centre sections. The ids match the data-tab attributes in local/manager.js.
// Order: status first, then the connections, then the game content, then the extension and the people.
const TABS = Object.freeze({
  overview: 'Overview',
  twitch: 'Twitch bot',
  broadcaster: 'Broadcaster',
  game: 'Game settings',
  loot: 'Loot table',
  extension: 'Twitch Extension',
  viewer: 'Viewers',
});

const TAB_IDS = Object.freeze(Object.keys(TABS));

function isTab(id) {
  return typeof id === 'string' && Object.hasOwn(TABS, id);
}

module.exports = { TABS, TAB_IDS, isTab };
