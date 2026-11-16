import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGroups, distributeRoles, defaultEffects } from './grouping.ts';

const players = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

test('9 players with 4 characters split 4 + 4 + 1', () => {
  const sizes = makeGroups(players(9), 4).map((g) => g.length);
  assert.deepEqual(sizes, [4, 4, 1]);
});

test('10 players with 4 characters split 4 + 4 + 2', () => {
  assert.deepEqual(makeGroups(players(10), 4).map((g) => g.length), [4, 4, 2]);
});

test('more characters than players gives one group', () => {
  assert.deepEqual(makeGroups(players(3), 5).map((g) => g.length), [3]);
});

test('every player lands in exactly one group', () => {
  const all = makeGroups(players(11), 3).flat().sort();
  assert.deepEqual(all, players(11).sort());
});

test('full group: one character per member', () => {
  const chars = [0, 1, 2, 3].map((id) => ({ id, load: 10 - id }));
  const roles = distributeRoles(['a', 'b', 'c', 'd'], chars);
  assert.equal(new Set(Object.values(roles)).size, 4);
});

test('solo player voices every character', () => {
  const chars = [0, 1, 2, 3].map((id) => ({ id, load: 5 }));
  const roles = distributeRoles(['solo'], chars);
  assert.deepEqual(Object.values(roles), ['solo', 'solo', 'solo', 'solo']);
});

test('short group balances speaking time', () => {
  const chars = [
    { id: 0, load: 30 },
    { id: 1, load: 5 },
    { id: 2, load: 5 },
    { id: 3, load: 5 },
  ];
  const roles = distributeRoles(['a', 'b'], chars);
  const owner0 = roles[0];
  // the 30 s part goes alone, the three short parts go to the other player
  assert.deepEqual([1, 2, 3].map((c) => roles[c] !== owner0), [true, true, true]);
});

test('extra characters of one player get distinct effects', () => {
  const chars = [0, 1, 2, 3].map((id) => ({ id, load: 10 - id }));
  const roles = distributeRoles(['solo'], chars);
  const effects = defaultEffects(roles, chars);
  assert.equal(effects[0], 'normal');
  assert.equal(new Set(Object.values(effects)).size, 4);
});
