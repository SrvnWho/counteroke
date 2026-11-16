import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup } from './cleanup.ts';

const DAY = 24 * 3600_000;
const NOW = Date.parse('2026-11-16T12:00:00Z');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'counteroke-cleanup-'));
  const dirs = { clipsDir: path.join(root, 'clips'), mixesDir: path.join(root, 'mixes'), recordingsDir: path.join(root, 'recordings') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d);
  /** writes a file and back-dates it (and its folder) by `ageDays` */
  const file = (rel: string, ageDays: number, bytes = 1000) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes));
    const t = new Date(NOW - ageDays * DAY);
    fs.utimesSync(p, t, t);
    fs.utimesSync(path.dirname(p), t, t);
  };
  const exists = (rel: string) => fs.existsSync(path.join(root, rel));
  return { root, dirs, file, exists };
}

test('old clips and scene videos go, recent and in-use ones stay', () => {
  const { dirs, file, exists } = setup();
  file('clips/old/clip.mp4', 10);
  file('clips/recent/clip.mp4', 2);
  file('clips/inuse/clip.mp4', 30);
  file('mixes/oldround/g1.mp4', 9);
  file('mixes/current/g1.mp4', 20);
  file('mixes/lastweek/g1.mp4', 3);

  const res = cleanup({ ...dirs, keepDays: 7, keepClipKeys: new Set(['inuse']), keepRoundIds: new Set(['current']), now: NOW });

  assert.equal(exists('clips/old'), false);
  assert.equal(exists('clips/recent'), true);
  assert.equal(exists('clips/inuse'), true);
  assert.equal(exists('mixes/oldround'), false);
  assert.equal(exists('mixes/current'), true);
  assert.equal(exists('mixes/lastweek'), true);
  assert.deepEqual([res.clips, res.rounds], [1, 1]);
  assert.equal(res.bytes, 2000);
});

test('leftovers: finished scenes, broken uploads and unfinished jobs', () => {
  const { dirs, file, exists } = setup();
  file('recordings/finished-round/p1.webm', 0);
  file('recordings/current/p1.webm', 0);
  file('recordings/upload-123-abc.webm', 0.5); // 12 hours old
  file('recordings/upload-456-def.webm', 0); // being uploaded right now
  file('clips/brokenjob/clip.mp4.part', 2);
  file('clips/runningjob/clip.mp4.part', 0);

  cleanup({ ...dirs, keepDays: 7, keepClipKeys: new Set(), keepRoundIds: new Set(['current']), now: NOW });

  assert.equal(exists('recordings/finished-round'), false);
  assert.equal(exists('recordings/current/p1.webm'), true);
  assert.equal(exists('recordings/upload-123-abc.webm'), false);
  assert.equal(exists('recordings/upload-456-def.webm'), true);
  assert.equal(exists('clips/brokenjob'), false);
  assert.equal(exists('clips/runningjob'), true);
});

test('keepDays 0 keeps clips and videos forever', () => {
  const { dirs, file, exists } = setup();
  file('clips/ancient/clip.mp4', 400);
  file('mixes/ancient/g1.mp4', 400);
  cleanup({ ...dirs, keepDays: 0, keepClipKeys: new Set(), keepRoundIds: new Set(), now: NOW });
  assert.equal(exists('clips/ancient'), true);
  assert.equal(exists('mixes/ancient'), true);
});

test('missing folders are fine', () => {
  const res = cleanup({
    clipsDir: path.join(os.tmpdir(), 'counteroke-nope-1'),
    mixesDir: path.join(os.tmpdir(), 'counteroke-nope-2'),
    recordingsDir: path.join(os.tmpdir(), 'counteroke-nope-3'),
    keepDays: 7,
    keepClipKeys: new Set(),
    keepRoundIds: new Set(),
    now: NOW,
  });
  assert.deepEqual(res, { clips: 0, rounds: 0, leftovers: 0, bytes: 0 });
});
