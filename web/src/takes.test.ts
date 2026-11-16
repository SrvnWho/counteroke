import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScriptLine } from '../../shared/types.ts';
import { buildChunks, encodeWav, LEAD, placeTakes, POST, PRE } from './takes.ts';

const line = (id: string, speaker: number, start: number, end: number): ScriptLine => ({ id, speaker, start, end, text: id });

test('only your lines become takes, each starting LEAD seconds early', () => {
  const lines = [line('a', 0, 2, 4), line('b', 1, 5, 6), line('c', 0, 10, 12)];
  const chunks = buildChunks(lines, new Set([0]), 20);
  assert.deepEqual(chunks.map((c) => c.id), ['a', 'c']);
  assert.equal(chunks[0].playFrom, 2 - LEAD);
  assert.equal(chunks[1].winEnd, 12 + POST);
});

test('every line is its own take, even when lines touch', () => {
  // the user's real case: one speaker, five lines with gaps of 0-0.7 s
  const lines = [line('a', 0, 0, 3), line('b', 0, 3.6, 6), line('c', 0, 6, 9), line('d', 0, 9.7, 12), line('e', 0, 12, 15)];
  const chunks = buildChunks(lines, new Set([0]), 20);
  assert.deepEqual(chunks.map((c) => c.lines.map((l) => l.id)), [['a'], ['b'], ['c'], ['d'], ['e']]);
  // touching lines: windows meet in the middle instead of overlapping
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i - 1].winEnd <= chunks[i].winStart);
  for (const c of chunks) assert.ok(c.winStart <= c.start && c.winEnd >= c.end);
});

test('a player voicing two characters gets both characters lines', () => {
  const lines = [line('a', 0, 1, 2), line('b', 1, 5, 6), line('c', 2, 9, 10)];
  assert.deepEqual(buildChunks(lines, new Set([0, 2]), 20).map((c) => c.id), ['a', 'c']);
});

test('windows stay inside the clip', () => {
  const chunks = buildChunks([line('a', 0, 0.1, 9.9)], new Set([0]), 10);
  assert.equal(chunks[0].winStart, 0);
  assert.equal(chunks[0].winEnd, 10);
  assert.equal(chunks[0].playFrom, 0);
  assert.ok(PRE > 0);
});

test('takes are placed at their clip time and nothing outside the window leaks', () => {
  const sr = 1000;
  const ones = new Float32Array(3000).fill(1); // a 3 s take of constant signal
  // take recorded from clip time 1.0 s, kept only between 2.0 and 3.0 s
  const out = placeTakes([{ samples: ones, sampleRate: sr, at: 1, winStart: 2, winEnd: 3 }], 5, sr);
  assert.equal(out.length, 5000);
  assert.equal(out[1500], 0); // before the window
  assert.equal(out[2500], 1); // inside
  assert.equal(out[3500], 0); // after
  assert.ok(out[2000] < 0.1 && out[2999] < 0.1); // faded edges
});

test('wav header describes mono 16-bit audio', () => {
  const wav = new DataView(encodeWav(new Float32Array([0, 1, -1]), 48000));
  const str = (o: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => wav.getUint8(o + i)));
  assert.equal(str(0), 'RIFF');
  assert.equal(str(8), 'WAVE');
  assert.equal(wav.getUint16(22, true), 1);
  assert.equal(wav.getUint32(24, true), 48000);
  assert.equal(wav.getUint32(40, true), 6);
  assert.equal(wav.getInt16(46, true), 32767);
  assert.equal(wav.getInt16(48, true), -32768);
});
