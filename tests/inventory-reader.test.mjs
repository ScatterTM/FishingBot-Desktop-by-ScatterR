import test from 'node:test';
import assert from 'node:assert/strict';
import { readInventoryItems } from '../lib/inventory.js';

test('inventory reader supports legacy JSON and current list storage', async () => {
  const legacy = {
    async lrange() { return []; },
    async get(key) {
      assert.equal(key, 'fish:rares:example_viewer');
      return JSON.stringify({ items: ['Blue Koi [RARE]', 'Gold Carp (Legendary)'] });
    },
  };
  assert.deepEqual(await readInventoryItems(legacy, 'example_viewer'), [
    'Blue Koi [RARE]', 'Gold Carp (Legendary)',
  ]);

  const current = {
    async lrange() { return ['Blue Koi [RARE]']; },
    async get() { return null; },
  };
  assert.deepEqual(await readInventoryItems(current, 'example_viewer'), ['Blue Koi [RARE]']);
});

test('inventory reader keeps legacy rows when new catches have already been appended', async () => {
  const db = {
    async lrange() { return ['New Fish [EPIC]']; },
    async get() { return JSON.stringify(['Old Fish [RARE]', 'Old Fish [RARE]']); },
  };
  assert.deepEqual(await readInventoryItems(db, 'example_viewer'), [
    'Old Fish [RARE]', 'Old Fish [RARE]', 'New Fish [EPIC]',
  ]);
});

test('inventory reader avoids double-counting a legacy prefix already migrated to the list', async () => {
  const db = {
    async lrange() { return ['Old Fish [RARE]', 'New Fish [EPIC]']; },
    async get() { return JSON.stringify(['Old Fish [RARE]']); },
  };
  assert.deepEqual(await readInventoryItems(db, 'example_viewer'), [
    'Old Fish [RARE]', 'New Fish [EPIC]',
  ]);
});
