import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AVATARS } from '../../shared/constants.ts';
import type { PlaylistTask, SuggestResult, WorkerJob } from '../../shared/types.ts';
import { parsePlaylistId } from '../../shared/youtube.ts';

// The game keeps its state under DATA_DIR, so point it at a throwaway folder before loading it.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'counteroke-game-'));
const { Game, JobGone } = await import('./game.ts');

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

// ------------------------------------------------------------------ rounds (no network, no ffmpeg)

// submitVideo looks the title up on YouTube in the background; keep tests offline.
globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;

const SCRIPT = {
  language: 'en',
  duration: 10,
  characters: [
    { id: 0, name: 'A' },
    { id: 1, name: 'B' },
  ],
  lines: [
    { id: 'x', start: 1, end: 3, speaker: 0, text: 'hello there' },
    { id: 'y', start: 4, end: 6, speaker: 1, text: 'hi' },
  ],
};

/** Plays a round up to the script screen with one 2-character video. */
function toScript(game: InstanceType<typeof Game>, host: string, videoId: string) {
  game.handle(host, { type: 'startGame' });
  game.handle(host, { type: 'submitVideo', url: `https://youtu.be/${videoId}`, start: 0, end: 10, speakers: 2, lang: 'en' });
  game.handle(host, { type: 'openVoting' }); // a single video wins right away
  const job = game.nextJob('pc', true) as WorkerJob;
  fs.writeFileSync(game.jobUploadPath(job.id), 'video');
  game.jobDone(job.id, SCRIPT);
  assert.equal(game.view(host).phase, 'script');
}

test('script lines can be added, re-timed and brought back after deleting', () => {
  const { game, join } = newGame();
  const host = join('Host');
  toScript(game, host, 'scriptvid01');
  const added = game.handle(host, { type: 'addLine', start: 3.5, end: 3.9, speaker: 1, text: ' yeni ' }) as { lineId: string };
  let lines = game.view(host).round!.script!.lines;
  assert.deepEqual(lines.map((l) => l.text), ['hello there', 'yeni', 'hi'], 'kept in time order');
  game.handle(host, { type: 'updateLine', lineId: added.lineId, start: 7, end: 8 });
  lines = game.view(host).round!.script!.lines;
  assert.equal(lines.at(-1)!.id, added.lineId, 'moved after re-timing');
  assert.throws(() => game.handle(host, { type: 'updateLine', lineId: added.lineId, end: 7.1 }), /0.2 sn/);

  const first = lines[0];
  game.handle(host, { type: 'deleteLine', lineId: first.id });
  game.handle(host, {
    type: 'addLine',
    start: first.start,
    end: first.end,
    speaker: first.speaker,
    text: first.text,
    words: [{ w: 'hello', s: 1, e: 1.5 }],
  });
  const back = game.view(host).round!.script!.lines[0];
  assert.equal(back.text, 'hello there');
  assert.deepEqual(back.words, [{ w: 'hello', s: 1, e: 1.5 }]);
});

test('latecomers are seated in a short group, or get their own', () => {
  const { game, join } = newGame();
  const host = join('Host');
  join('Ali');
  join('Ayşe');
  toScript(game, host, 'latevideo01');
  game.handle(host, { type: 'openCasting' });
  const sizes = () => game.view(host).round!.groups.map((g) => g.members.length).sort();
  assert.deepEqual(sizes(), [1, 2]);

  const cem = join('Cem'); // joins during casting: fills the short group
  assert.deepEqual(sizes(), [2, 2]);
  const cemGroup = game.view(host).round!.groups.find((g) => g.members.includes(cem))!;
  assert.equal(new Set(Object.values(cemGroup.roles)).size, 2, 'roles dealt again: one character each');

  game.handle(host, { type: 'openRecording' });
  const deniz = join('Deniz'); // every group is full: a group of their own, voicing both characters
  const own = game.view(host).round!.groups.find((g) => g.members.includes(deniz))!;
  assert.deepEqual(own.members, [deniz]);
  assert.deepEqual(Object.values(own.roles), [deniz, deniz]);
  join('Ece'); // the solo group hasn't recorded anything yet: Ece joins it
  assert.deepEqual(sizes(), [2, 2, 2]);

  // nobody recorded: groups are not screened as plain music
  game.handle(host, { type: 'finishRecording' });
  const groups = game.view(host).round!.groups;
  assert.ok(groups.every((g) => g.mixStatus === 'error' && /kayıt göndermedi/.test(g.mixError ?? '')));
  assert.equal(game.view(host).phase, 'mixing');
});

function submissionOf(game: InstanceType<typeof Game>, viewer: string, owner: string): string {
  return game.view(viewer).submissions.find((s) => s.playerId === owner)!.id;
}

test('the vote leader is processed ahead of time and the winner keeps that work', () => {
  const { game, join } = newGame();
  const host = join('Host');
  const ali = join('Ali');
  const ayse = join('Ayşe');
  game.handle(host, { type: 'startGame' });
  game.handle(ali, { type: 'submitVideo', url: 'https://youtu.be/prefetchA01', start: 0, end: 10, speakers: 1, lang: 'tr' });
  game.handle(ayse, { type: 'submitVideo', url: 'https://youtu.be/prefetchB01', start: 0, end: 10, speakers: 1, lang: 'tr' });
  assert.equal(game.nextJob('phone', false), null, 'no fast worker: the pool is not processed in advance');
  game.handle(host, { type: 'openVoting' });
  assert.equal(game.nextJob('phone', false), null, 'no votes yet: no leader');

  game.handle(host, { type: 'vote', submissionId: submissionOf(game, host, ali) });
  const early = game.nextJob('phone', false) as WorkerJob;
  assert.equal(early.youtubeId, 'prefetchA01', 'the leader is handed to the phone');
  game.jobProgress(early.id, 'separate', 0.3);

  game.handle(ayse, { type: 'vote', submissionId: submissionOf(game, host, ali) });
  game.handle(ali, { type: 'vote', submissionId: submissionOf(game, host, ayse) });
  const v = game.view(host);
  assert.equal(v.phase, 'processing');
  assert.equal(v.round!.submission!.youtubeId, 'prefetchA01');
  assert.equal(v.round!.clip!.status, 'processing', 'picks up the job that is already running');
  assert.equal(v.round!.clip!.stage, 'separate');
  assert.equal(v.round!.clip!.progress, 0.3);
});

test('work on a video that lost the vote is called off', () => {
  const { game, join } = newGame();
  const host = join('Host');
  const ali = join('Ali');
  const ayse = join('Ayşe');
  game.handle(host, { type: 'startGame' });
  game.handle(ali, { type: 'submitVideo', url: 'https://youtu.be/lostvideo01', start: 0, end: 10, speakers: 1, lang: 'tr' });
  game.handle(ayse, { type: 'submitVideo', url: 'https://youtu.be/wonvideo001', start: 0, end: 10, speakers: 1, lang: 'tr' });
  game.handle(host, { type: 'openVoting' });
  game.handle(host, { type: 'vote', submissionId: submissionOf(game, host, ali) });
  const early = game.nextJob('phone', false) as WorkerJob;
  assert.equal(early.youtubeId, 'lostvideo01');
  game.handle(ali, { type: 'vote', submissionId: submissionOf(game, host, ayse) });
  game.handle(host, { type: 'vote', submissionId: submissionOf(game, host, ayse) }); // changes their vote
  game.handle(ayse, { type: 'vote', submissionId: submissionOf(game, host, ali) });
  assert.equal(game.view(host).round!.submission!.youtubeId, 'wonvideo001');
  assert.throws(() => game.jobProgress(early.id, 'transcribe', 0.6), JobGone, 'the worker is told to stop');
  const next = game.nextJob('phone', false) as WorkerJob;
  assert.equal(next.youtubeId, 'wonvideo001');
});

test('with a fast worker online the whole pool is processed', () => {
  const { game, join } = newGame();
  const host = join('Host');
  const ali = join('Ali');
  game.handle(host, { type: 'startGame' });
  game.nextJob('pc', true); // the PC says hello
  game.handle(ali, { type: 'submitVideo', url: 'https://youtu.be/poolvideo01', start: 0, end: 10, speakers: 1, lang: 'tr' });
  game.handle(host, { type: 'submitVideo', url: 'https://youtu.be/poolvideo02', start: 0, end: 10, speakers: 1, lang: 'tr' });
  assert.equal(game.nextJob('phone', false), null, 'pool work is left to the fast worker');
  const a = game.nextJob('pc', true) as WorkerJob;
  const b = game.nextJob('pc', true) as WorkerJob;
  assert.deepEqual([a.youtubeId, b.youtubeId].sort(), ['poolvideo01', 'poolvideo02']);
});
