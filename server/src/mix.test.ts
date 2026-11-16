import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFilterGraph, effectFilter } from './mix.ts';

test('pitch effects keep the clip length (rate x tempo = 1)', () => {
  for (const effect of ['kalin', 'ince', 'canavar'] as const) {
    const f = effectFilter(effect);
    const rate = Number(f.match(/asetrate=(\d+)/)![1]) / 48000;
    const tempo = Number(f.match(/atempo=([\d.]+)/)![1]);
    assert.ok(Math.abs(rate * tempo - 1) < 0.001, `${effect}: ${rate} x ${tempo}`);
  }
});

test('single-character track has no gate', () => {
  const { graph, voiceCount } = buildFilterGraph([
    { file: 'a.webm', trimMs: 100, parts: [{ characterId: 0, effect: 'normal', segments: [[1, 2]] }] },
  ]);
  assert.equal(voiceCount, 1);
  assert.ok(!graph.includes('enable='));
  assert.ok(graph.includes('atrim=start=0.100'));
  assert.ok(graph.includes('amix=inputs=2'));
});

test('multi-character track is split and gated per character', () => {
  const { graph, voiceCount } = buildFilterGraph([
    {
      file: 'a.webm',
      trimMs: -250,
      parts: [
        { characterId: 0, effect: 'normal', segments: [[0, 1]] },
        { characterId: 1, effect: 'robot', segments: [[2, 3]] },
      ],
    },
  ]);
  assert.equal(voiceCount, 2);
  assert.ok(graph.includes('adelay=250'));
  assert.ok(graph.includes('asplit=2'));
  // primary character is muted only inside the other character's lines
  assert.ok(graph.includes("[t0_0]volume=0:enable='between(t,1.65,3.35)'"));
  // second character is muted everywhere except its own lines
  assert.ok(graph.includes("[t0_1]volume=0:enable='not(between(t,1.65,3.35))'"));
});

test('no recordings still yields a valid graph (music only)', () => {
  const { graph, voiceCount } = buildFilterGraph([]);
  assert.equal(voiceCount, 0);
  assert.ok(graph.endsWith('[bg]amix=inputs=1:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]'));
});
