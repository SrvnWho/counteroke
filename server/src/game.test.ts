import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AVATARS } from '../../shared/constants.ts';
import type { PlaylistTask, SuggestResult } from '../../shared/types.ts';
import { parsePlaylistId } from '../../shared/youtube.ts';

// The game keeps its state under DATA_DIR, so point it at a throwaway folder before loading it.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'counteroke-game-'));
const { Game } = await import('./game.ts');

function newGame() {
  const game = new Game(() => {});
  const join = (name: string, avatar?: string) => {
    const { playerId } = game.join(name, '', avatar);
    game.connect(playerId);
    return playerId;
  };
  return { game, join, me: (id: string) => game.view(id).me! };
}

test('players get different avatars and can pick a free one', () => {
  const { game, join, me } = newGame();
  const a = join('Ali', '🐙');
  const b = join('Ayşe', '🐙'); // taken: gets another one
  assert.equal(me(a).avatar, '🐙');
  assert.notEqual(me(b).avatar, '🐙');
  assert.ok(AVATARS.includes(me(b).avatar));

  assert.throws(() => game.handle(b, { type: 'setProfile', name: 'Ayşe', avatar: '🐙' }), /başka biri/);
  assert.throws(() => game.handle(b, { type: 'setProfile', name: 'ali', avatar: '🐼' }), /alınmış/);
  assert.throws(() => game.handle(b, { type: 'setProfile', name: 'Ayşe', avatar: 'x' }), /Bilinmeyen/);
  game.handle(b, { type: 'setProfile', name: '  Ayşe  Nur ', avatar: '🐼' });
  assert.equal(me(b).name, 'Ayşe Nur');
  assert.equal(me(b).avatar, '🐼');
});

test('playlist links are recognised', () => {
  assert.equal(parsePlaylistId('https://www.youtube.com/playlist?list=PLabcdefghijkl123'), 'PLabcdefghijkl123');
  assert.equal(parsePlaylistId('https://youtube.com/watch?v=jNQXAC9IVRw&list=PLabcdefghijkl123&index=2'), 'PLabcdefghijkl123');
  assert.equal(parsePlaylistId('PLabcdefghijkl123'), 'PLabcdefghijkl123');
  assert.equal(parsePlaylistId('https://www.youtube.com/watch?v=jNQXAC9IVRw'), null);
  assert.equal(parsePlaylistId('https://example.com/?list=PLabcdefghijkl123'), null);
});

test('the playlist is read by a worker and suggestions avoid repeats', () => {
  const { game, join } = newGame();
  const host = join('Host');
  const other = join('Misafir');
  assert.throws(() => game.handle(other, { type: 'setPlaylist', url: 'PLabcdefghijkl123' }), /oda sahibi/);
  game.handle(host, { type: 'setPlaylist', url: 'https://www.youtube.com/playlist?list=PLabcdefghijkl123' });
  assert.equal(game.view(host).playlist?.status, 'loading');

  // old workers that do not announce the capability never get the task
  assert.equal(game.nextJob('old', true, false), null);
  const task = game.nextJob('pc', true, true) as PlaylistTask;
  assert.equal(task.kind, 'playlist');
  assert.equal(task.url, 'https://www.youtube.com/playlist?list=PLabcdefghijkl123');
  assert.equal(game.nextJob('phone', false, true), null, 'claimed task is not handed out twice');

  const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd', 'eeeeeeeeeee'];
  game.playlistResult(task.id, {
    title: 'Kısa klipler',
    items: [...ids.map((id, i) => ({ youtubeId: id, title: `Video ${i}`, duration: 15 })), { youtubeId: 'bad' }, { youtubeId: ids[0] }],
  });
  const pl = game.view(host).playlist!;
  assert.equal(pl.status, 'ready');
  assert.equal(pl.count, 5, 'invalid and duplicate entries are dropped');
  assert.equal(pl.title, 'Kısa klipler');

  const first = game.handle(other, { type: 'suggest' }) as SuggestResult;
  assert.equal(first.items.length, 2);
  assert.notEqual(first.items[0].youtubeId, first.items[1].youtubeId);
  const seen = first.items.map((x) => x.youtubeId);
  const second = game.handle(other, { type: 'suggest', exclude: seen }) as SuggestResult;
  for (const s of second.items) assert.ok(!seen.includes(s.youtubeId), 'refresh shows new videos');
  // everything seen: falls back to older ones, but never the two on screen right now
  const all = [...ids.filter((id) => !second.items.some((s) => s.youtubeId === id)), ...second.items.map((s) => s.youtubeId)];
  const third = game.handle(other, { type: 'suggest', exclude: all }) as SuggestResult;
  assert.equal(third.items.length, 2);
  for (const s of third.items) assert.ok(!all.slice(-2).includes(s.youtubeId));
});

test('a failed playlist read is reported, and a stale answer is ignored', () => {
  const { game, join } = newGame();
  const host = join('Host');
  game.handle(host, { type: 'setPlaylist', url: 'PLaaaaaaaaaaaa1' });
  const t1 = game.nextJob('pc', true, true) as PlaylistTask;
  game.handle(host, { type: 'setPlaylist', url: 'PLbbbbbbbbbbbb2' });
  game.playlistResult(t1.id, { items: [{ youtubeId: 'aaaaaaaaaaa', title: 'eski' }] });
  assert.equal(game.view(host).playlist?.count, 0, 'answer for the replaced list is dropped');
  const t2 = game.nextJob('pc', true, true) as PlaylistTask;
  game.playlistResult(t2.id, { error: 'Böyle bir oynatma listesi yok ya da gizli.' });
  assert.equal(game.view(host).playlist?.status, 'error');
  assert.throws(() => game.handle(host, { type: 'suggest' }), /hazır değil/);
  game.handle(host, { type: 'setPlaylist', url: '' });
  assert.equal(game.view(host).playlist, null);
});
