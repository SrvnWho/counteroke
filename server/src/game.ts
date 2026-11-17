import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AVATARS, EFFECT_IDS, MAX_SPEAKERS, PLAYER_COLORS } from '../../shared/constants.ts';
import type { EffectId } from '../../shared/constants.ts';
import type {
  Action,
  ClipView,
  GameView,
  GroupResult,
  GroupView,
  JoinResult,
  Lang,
  Phase,
  PlayerView,
  PlaylistTask,
  PlaylistView,
  RoundView,
  Script,
  ScriptLine,
  SubmissionView,
  Suggestion,
  SuggestResult,
  Word,
  WorkerJob,
} from '../../shared/types.ts';
import { config } from './config.ts';
import { characterLoads, defaultEffects, distributeRoles, makeGroups, shuffle } from './grouping.ts';
import { mixGroup } from './mix.ts';
import type { Track } from './mix.ts';
import { fetchTitle, parsePlaylistId, parseYouTubeId, playlistUrl, watchUrl } from '../../shared/youtube.ts';

/** An error whose message is shown to the player as-is. */
export class GameError extends Error {}

/** A worker asked about a job the server dropped (another video won); the worker stops it. */
export class JobGone extends GameError {}

interface Player {
  id: string;
  secret: string;
  name: string;
  isHost: boolean;
  score: number;
  color: string;
  avatar: string;
  joinedAt: number;
}

interface Submission extends SubmissionView {
  createdAt: number;
}

interface Clip {
  key: string;
  status: ClipView['status'];
  stage: string;
  progress: number;
  error?: string;
  duration?: number;
  workerName?: string;
  jobId?: string;
}

interface Job extends WorkerJob {
  key: string;
  status: 'queued' | 'claimed';
  claimedBy?: string;
  updatedAt: number;
  /**
   * Set for work done ahead of time: 'leader' = the video leading the vote (any worker),
   * 'pool' = another video in the pool (only fast workers). Unset = needed right now.
   */
  prep?: 'leader' | 'pool';
  stage?: string;
  progress?: number;
}

interface Recording {
  file: string;
  trimMs: number;
  uploadedAt: number;
}

interface Group {
  id: string;
  index: number;
  members: string[];
  roles: Record<number, string>;
  effects: Record<number, EffectId>;
  ready: string[];
  recordings: Record<string, Recording>;
  mixStatus: GroupView['mixStatus'];
  mixError?: string;
  mixVersion: number;
  mixDirty?: boolean;
  takeStartAt?: number;
  /** line-by-line: index (into script.lines) of the line the group is on */
  lineCursor?: number;
  /** line-by-line: the line being played/recorded right now */
  lineTake?: { index: number; startAt: number; by: string };
  /** line-by-line: indexes of lines whose voice actor has recorded them */
  linesDone?: number[];
}

/** A line take counts as running until its line (plus slack) has surely finished. */
function lineTakeActive(g: Group, script: Script, now = Date.now()): boolean {
  const t = g.lineTake;
  if (!t) return false;
  const line = script.lines[t.index];
  const length = line ? line.end - Math.max(0, line.start - 1.5) : 0;
  return now < t.startAt + (length + 8) * 1000;
}

interface Round {
  id: string;
  number: number;
  submission?: Submission;
  votes: Record<string, string>;
  voteTally?: Record<string, number>;
  clip?: Clip;
  script?: Script;
  groups: Group[];
  screeningOrder: string[];
  screeningIndex: number;
  screeningStartAt?: number;
  screenSeq?: number;
  screenReady?: string[];
  ratings: Record<string, Record<string, number>>;
  results?: GroupResult[];
  winnerGroupIds?: string[];
}

/** The host's suggestion playlist; a worker reads its video list with yt-dlp. */
interface Playlist {
  url: string;
  listId: string;
  title?: string;
  status: PlaylistView['status'];
  error?: string;
  items: Suggestion[];
  /** set while the list still has to be (re)read */
  taskId?: string;
  claimedAt?: number;
  readAt?: number;
}

interface State {
  phase: Phase;
  players: Player[];
  submissions: Submission[];
  round: Round | null;
  roundCounter: number;
  jobs: Job[];
  playlist?: Playlist;
  /** youtube ids of videos already played, so suggestions skip them */
  played?: string[];
}

const WORKER_ONLINE_MS = 15_000;
const STALE_JOB_MS = 10 * 60_000;
const SELECTION_BONUS = 1;
const PLAYLIST_TASK_MS = 2 * 60_000;
/** the gala waits at most this long for slow players' videos to load */
const SCREEN_WAIT_MS = 8000;
const SCREEN_COUNTDOWN_MS = 3000;
/** re-read the playlist after this long, so videos added to it show up */
const PLAYLIST_REFRESH_MS = 24 * 3600_000;

function freshState(): State {
  return { phase: 'lobby', players: [], submissions: [], round: null, roundCounter: 0, jobs: [] };
}

function clipKey(s: Submission): string {
  return `${s.youtubeId}_${s.start.toFixed(1)}-${s.end.toFixed(1)}_${s.lang}_${s.speakers}`;
}

function clampInt(n: unknown, min: number, max: number): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) throw new GameError('Geçersiz sayı');
  return Math.min(max, Math.max(min, v));
}

function cleanText(s: unknown, max: number): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Word timings sent back by a client (undoing a deleted line); anything odd is dropped. */
function cleanWords(raw: unknown): Word[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const words = raw
    .slice(0, 500)
    .map((x) => ({ w: cleanText((x as Word)?.w, 60), s: Number((x as Word)?.s), e: Number((x as Word)?.e) }))
    .filter((x) => x.w && Number.isFinite(x.s) && Number.isFinite(x.e));
  return words.length ? words : undefined;
}

/** State writes run one at a time, so a slow disk never has two writers on the same temp file. */
let saveChain: Promise<void> = Promise.resolve();

/** First avatar nobody else has, starting from the player's seat so newcomers get different ones. */
function freeAvatar(players: { id: string; avatar?: string }[], playerId: string): string {
  const used = new Set(players.filter((p) => p.id !== playerId && p.avatar).map((p) => p.avatar));
  const seat = players.findIndex((p) => p.id === playerId);
  const from = (seat < 0 ? players.length : seat) % AVATARS.length;
  for (let i = 0; i < AVATARS.length; i++) {
    const a = AVATARS[(from + i) % AVATARS.length];
    if (!used.has(a)) return a;
  }
  return AVATARS[from];
}

export class Game {
  private state: State;
  private sockets = new Map<string, number>();
  private workers = new Map<string, { lastSeen: number; fast: boolean }>();
  private hostTimers = new Map<string, NodeJS.Timeout>();
  private mixChain: Promise<void> = Promise.resolve();
  /** clips whose pre-processing failed: not retried ahead of time (they still run if picked) */
  private failedPrep = new Set<string>();
  private screenTimer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
    this.state = this.load();
  }

  // ---------------------------------------------------------------- persistence

  private load(): State {
    let s: State;
    try {
      s = { ...freshState(), ...JSON.parse(fs.readFileSync(config.stateFile, 'utf8')) };
    } catch {
      return freshState();
    }
    for (const j of s.jobs) if (j.status === 'claimed') j.status = 'queued';
    for (const p of s.players) if (!p.avatar) p.avatar = freeAvatar(s.players, p.id);
    const pl = s.playlist;
    if (pl) {
      delete pl.claimedAt;
      if (!pl.taskId && Date.now() - (pl.readAt ?? 0) > PLAYLIST_REFRESH_MS) pl.taskId = randomUUID();
    }
    const r = s.round;
    if (r) {
      if (r.clip?.status === 'processing') r.clip.status = 'queued';
      for (const g of r.groups) {
        delete g.takeStartAt;
        if (g.mixStatus === 'mixing') g.mixStatus = 'none';
      }
    }
    if (s.phase === 'mixing') setTimeout(() => this.requestAllMixes(), 0);
    // restarted while the gala waited for players: just start it
    if (s.phase === 'screening' && r && !r.screeningStartAt) r.screeningStartAt = Date.now() + 4000;
    return s;
  }

  private changed(): void {
    this.onChange();
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      saveChain = saveChain.then(() => this.save());
    }, 300);
  }

  private async save(): Promise<void> {
    const tmp = `${config.stateFile}.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(this.state));
      await fs.promises.rename(tmp, config.stateFile);
    } catch (e) {
      console.error('state kaydedilemedi', e);
    }
  }

  // ---------------------------------------------------------------- players

  join(nameRaw: unknown, password: unknown, avatarRaw?: unknown): JoinResult {
    if (config.gamePassword && password !== config.gamePassword) throw new GameError('Şifre yanlış');
    const name = cleanText(nameRaw, 20);
    if (!name) throw new GameError('Bir isim yaz');
    const secret = randomBytes(18).toString('base64url');
    const players = this.state.players;
    const wanted = typeof avatarRaw === 'string' && AVATARS.includes(avatarRaw) ? avatarRaw : null;
    const existing = players.find((p) => p.name.toLocaleLowerCase('tr') === name.toLocaleLowerCase('tr'));
    if (existing) {
      if (this.isConnected(existing.id)) throw new GameError('Bu isim şu an oyunda, başka bir isim seç');
      // Same name, nobody using it: take that seat back (e.g. after clearing the browser).
      existing.secret = secret;
      if (wanted && !this.avatarTaken(wanted, existing.id)) existing.avatar = wanted;
      this.changed();
      return { playerId: existing.id, secret };
    }
    const id = randomUUID();
    const player: Player = {
      id,
      secret,
      name,
      isHost: !players.some((p) => p.isHost),
      score: 0,
      color: PLAYER_COLORS[players.length % PLAYER_COLORS.length],
      avatar: wanted && !this.avatarTaken(wanted, id) ? wanted : freeAvatar(players, id),
      joinedAt: Date.now(),
    };
    this.state.players.push(player);
    this.changed();
    return { playerId: player.id, secret };
  }

  auth(playerId: unknown, secret: unknown): boolean {
    const p = this.state.players.find((x) => x.id === playerId);
    return !!p && typeof secret === 'string' && p.secret === secret;
  }

  connect(playerId: string): void {
    const before = this.sockets.get(playerId) ?? 0;
    this.sockets.set(playerId, before + 1);
    if (before === 0) this.seatLatecomer(playerId);
    const t = this.hostTimers.get(playerId);
    if (t) {
      clearTimeout(t);
      this.hostTimers.delete(playerId);
    }
    this.changed();
  }

  disconnect(playerId: string): void {
    const n = Math.max(0, (this.sockets.get(playerId) ?? 1) - 1);
    this.sockets.set(playerId, n);
    const p = this.player(playerId);
    if (n === 0 && p?.isHost) {
      this.hostTimers.set(
        playerId,
        setTimeout(() => {
          this.hostTimers.delete(playerId);
          if (this.isConnected(playerId)) return;
          const next = [...this.state.players].sort((a, b) => a.joinedAt - b.joinedAt).find((x) => this.isConnected(x.id));
          if (next) {
            p.isHost = false;
            next.isHost = true;
            this.changed();
          }
        }, 20_000),
      );
    }
    this.changed();
  }

  /**
   * Someone who joins (or comes back) after the groups were made still gets to play: they join a
   * group that is short of people and has not started recording, or form a new group of their own.
   */
  private seatLatecomer(playerId: string): void {
    const s = this.state;
    const r = s.round;
    if (!r?.script || (s.phase !== 'casting' && s.phase !== 'recording')) return;
    if (r.groups.some((g) => g.members.includes(playerId))) return;
    const loads = characterLoads(r.script);
    const untouched = (g: Group) =>
      !Object.keys(g.recordings).length && !g.linesDone?.length && !g.lineTake && !g.takeStartAt;
    const open = r.groups
      .filter((g) => g.members.length < r.script!.characters.length && (s.phase === 'casting' || untouched(g)))
      .sort((a, b) => a.members.length - b.members.length)[0];
    if (open) {
      open.members.push(playerId);
      open.roles = distributeRoles(open.members, loads);
      open.effects = defaultEffects(open.roles, loads);
      open.ready = [];
      return;
    }
    const roles = distributeRoles([playerId], loads);
    r.groups.push({
      id: randomUUID(),
      index: r.groups.length,
      members: [playerId],
      roles,
      effects: defaultEffects(roles, loads),
      ready: [],
      recordings: {},
      mixStatus: 'none',
      mixVersion: 0,
    });
  }

  private isConnected(id: string): boolean {
    return (this.sockets.get(id) ?? 0) > 0;
  }

  private player(id: string): Player | undefined {
    return this.state.players.find((p) => p.id === id);
  }

  private avatarTaken(avatar: string, exceptId: string): boolean {
    return this.state.players.some((p) => p.id !== exceptId && p.avatar === avatar);
  }

  // ---------------------------------------------------------------- actions

  handle(playerId: string, action: Action): unknown {
    const me = this.player(playerId);
    if (!me) throw new GameError('Oyuncu bulunamadı');
    const host = () => {
      if (!me.isHost) throw new GameError('Bunu sadece oda sahibi yapabilir');
    };
    const phase = (...allowed: Phase[]) => {
      if (!allowed.includes(this.state.phase)) throw new GameError('Şu an bunu yapamazsın');
    };
    const s = this.state;
    let result: unknown;

    switch (action.type) {
      case 'startGame':
        host();
        phase('lobby');
        s.phase = 'submit';
        break;

      case 'setProfile': {
        const name = cleanText(action.name, 20);
        if (!name) throw new GameError('Bir isim yaz');
        if (s.players.some((p) => p.id !== me.id && p.name.toLocaleLowerCase('tr') === name.toLocaleLowerCase('tr')))
          throw new GameError('Bu isim alınmış');
        if (!AVATARS.includes(action.avatar)) throw new GameError('Bilinmeyen avatar');
        if (this.avatarTaken(action.avatar, me.id)) throw new GameError('Bu avatarı başka biri aldı');
        me.name = name;
        me.avatar = action.avatar;
        break;
      }

      case 'setPlaylist': {
        host();
        const raw = String(action.url ?? '').trim();
        if (!raw) {
          delete s.playlist;
          break;
        }
        const listId = parsePlaylistId(raw);
        if (!listId) throw new GameError('Bu bir YouTube oynatma listesi linki gibi görünmüyor (içinde list= olmalı)');
        const old = s.playlist?.listId === listId ? s.playlist : undefined;
        s.playlist = {
          url: playlistUrl(listId),
          listId,
          title: old?.title,
          status: old?.items.length ? 'ready' : 'loading',
          items: old?.items ?? [],
          taskId: randomUUID(),
        };
        break;
      }

      case 'suggest':
        return this.suggest(Array.isArray(action.exclude) ? action.exclude.map(String) : []);

      case 'removePlayer': {
        host();
        phase('lobby', 'submit', 'results');
        if (this.isConnected(action.playerId)) throw new GameError('Bağlı bir oyuncu çıkarılamaz');
        s.players = s.players.filter((p) => p.id !== action.playerId);
        s.submissions = s.submissions.filter((x) => x.playerId !== action.playerId);
        break;
      }

      case 'resetGame':
        host();
        for (const p of s.players) p.score = 0;
        s.submissions = [];
        s.round = null;
        s.jobs = [];
        s.phase = 'lobby';
        fs.rmSync(config.recordingsDir, { recursive: true, force: true });
        fs.rmSync(config.mixesDir, { recursive: true, force: true });
        break;

      case 'submitVideo':
        phase('submit');
        this.submitVideo(me, action);
        this.prefetch();
        break;

      case 'removeSubmission': {
        phase('submit');
        const sub = s.submissions.find((x) => x.id === action.submissionId);
        if (!sub) break;
        if (sub.playerId !== me.id && !me.isHost) throw new GameError('Sadece kendi videonu kaldırabilirsin');
        s.submissions = s.submissions.filter((x) => x !== sub);
        this.prefetch();
        break;
      }

      case 'openVoting':
        host();
        phase('submit');
        this.openVoting();
        break;

      case 'vote': {
        phase('vote');
        const sub = s.submissions.find((x) => x.id === action.submissionId);
        if (!sub) throw new GameError('Video bulunamadı');
        if (sub.playerId === me.id) throw new GameError('Kendi videona oy veremezsin');
        s.round!.votes[me.id] = sub.id;
        if (this.everyoneVoted()) this.closeVoting();
        else this.prefetch();
        break;
      }

      case 'closeVoting':
        host();
        phase('vote');
        this.closeVoting();
        break;

      case 'retryProcessing': {
        host();
        phase('processing');
        const r = s.round!;
        if (r.clip?.status !== 'error') throw new GameError('Video zaten işleniyor');
        this.startProcessing();
        break;
      }

      case 'backToVoting': {
        host();
        phase('processing');
        const r = s.round!;
        if (r.submission) {
          const owner = this.player(r.submission.playerId);
          if (owner) owner.score -= SELECTION_BONUS;
        }
        if (r.clip?.jobId) s.jobs = s.jobs.filter((j) => j.id !== r.clip!.jobId);
        s.round = null;
        s.roundCounter -= 1;
        if (s.submissions.length) this.openVoting();
        else s.phase = 'submit';
        break;
      }

      case 'updateLine': {
        phase('script', 'casting');
        const script = this.script();
        const line = script.lines.find((l) => l.id === action.lineId);
        if (!line) throw new GameError('Replik bulunamadı');
        if (action.text !== undefined) {
          const text = cleanText(action.text, 300);
          if (text !== line.text) {
            line.text = text;
            delete line.words;
          }
        }
        if (action.speaker !== undefined) line.speaker = clampInt(action.speaker, 0, script.characters.length - 1);
        if (action.start !== undefined || action.end !== undefined) {
          const max = script.duration > 0 ? script.duration : Infinity;
          const start = Math.max(0, Math.min(max, Number(action.start ?? line.start)));
          const end = Math.max(0, Math.min(max, Number(action.end ?? line.end)));
          if (!Number.isFinite(start) || !Number.isFinite(end) || end < start + 0.2)
            throw new GameError('Bitiş, başlangıçtan en az 0.2 sn sonra olmalı');
          line.start = round2(start);
          line.end = round2(end);
          delete line.words; // the old word timings no longer fit; the prompter spreads the words evenly
          script.lines.sort((a, b) => a.start - b.start);
        }
        break;
      }

      case 'addLine': {
        phase('script', 'casting');
        const script = this.script();
        const max = script.duration > 0 ? script.duration : Infinity;
        const start = Math.max(0, Math.min(max - 0.2, Number(action.start) || 0));
        const end = Math.min(max, Math.max(start + 0.2, Number(action.end) || start + 2));
        const line: ScriptLine = {
          id: randomUUID().slice(0, 8),
          start: round2(start),
          end: round2(end),
          speaker: clampInt(action.speaker ?? 0, 0, script.characters.length - 1),
          text: cleanText(action.text, 300),
          words: cleanWords(action.words),
        };
        script.lines.push(line);
        script.lines.sort((a, b) => a.start - b.start);
        result = { lineId: line.id };
        break;
      }

      case 'deleteLine': {
        phase('script', 'casting');
        const script = this.script();
        script.lines = script.lines.filter((l) => l.id !== action.lineId);
        break;
      }

      case 'renameCharacter': {
        phase('script', 'casting');
        const c = this.script().characters.find((x) => x.id === action.characterId);
        if (!c) throw new GameError('Karakter bulunamadı');
        c.name = cleanText(action.name, 30) || `Karakter ${c.id + 1}`;
        break;
      }

      case 'setCharacterCount': {
        phase('script');
        const script = this.script();
        const count = clampInt(action.count, 1, MAX_SPEAKERS);
        while (script.characters.length < count) {
          const id = script.characters.length;
          script.characters.push({ id, name: `Karakter ${id + 1}` });
        }
        script.characters = script.characters.slice(0, count);
        for (const l of script.lines) if (l.speaker >= count) l.speaker = 0;
        break;
      }

      case 'openCasting':
        host();
        phase('script');
        this.openCasting();
        break;

      case 'setRole': {
        phase('casting');
        const g = this.group(action.groupId);
        if (!g.members.includes(me.id) && !me.isHost) throw new GameError('Sadece kendi grubunda değişiklik yapabilirsin');
        if (!g.members.includes(action.playerId)) throw new GameError('Bu oyuncu bu grupta değil');
        if (!this.script().characters.some((c) => c.id === action.characterId)) throw new GameError('Karakter bulunamadı');
        g.roles[action.characterId] = action.playerId;
        g.ready = [];
        break;
      }

      case 'setEffect': {
        phase('casting', 'recording');
        const g = this.group(action.groupId);
        if (!g.members.includes(me.id) && !me.isHost) throw new GameError('Sadece kendi grubunda değişiklik yapabilirsin');
        if (!EFFECT_IDS.includes(action.effect)) throw new GameError('Bilinmeyen efekt');
        g.effects[action.characterId] = action.effect;
        if (g.mixStatus !== 'none') this.requestMix(g);
        break;
      }

      case 'setReady': {
        phase('casting');
        const g = s.round!.groups.find((x) => x.members.includes(me.id));
        if (!g) throw new GameError('Bu turda bir grupta değilsin');
        g.ready = g.ready.filter((id) => id !== me.id);
        if (action.ready) g.ready.push(me.id);
        const allReady = s.round!.groups.every((x) =>
          x.members.every((m) => x.ready.includes(m) || !this.isConnected(m)),
        );
        if (allReady) s.phase = 'recording';
        break;
      }

      case 'openRecording':
        host();
        phase('casting');
        s.phase = 'recording';
        break;

      case 'groupTake': {
        phase('recording');
        const g = s.round!.groups.find((x) => x.members.includes(me.id));
        if (!g) throw new GameError('Bu turda bir grupta değilsin');
        g.takeStartAt = Date.now() + 4000;
        break;
      }

      case 'lineGo': {
        phase('recording');
        const g = this.myGroupOrThrow(me.id);
        const script = this.script();
        if (lineTakeActive(g, script)) throw new GameError('Şu an bir replik kaydediliyor');
        g.lineCursor = clampInt(action.index, 0, script.lines.length);
        delete g.lineTake;
        break;
      }

      case 'lineStart': {
        phase('recording');
        const g = this.myGroupOrThrow(me.id);
        const script = this.script();
        if (lineTakeActive(g, script)) throw new GameError('Şu an bir replik kaydediliyor');
        const index = g.lineCursor ?? 0;
        const line = script.lines[index];
        if (!line) throw new GameError('Sahne bitti, kaydedilecek replik kalmadı');
        if (g.roles[line.speaker] !== me.id) throw new GameError('Bu replik başka birinin');
        g.lineTake = { index, startAt: Date.now() + 3000, by: me.id };
        break;
      }

      case 'lineDone': {
        phase('recording');
        const g = this.myGroupOrThrow(me.id);
        const index = clampInt(action.index, 0, 10_000);
        if (g.lineTake?.index === index && g.lineTake.by === me.id) delete g.lineTake;
        g.linesDone = [...new Set([...(g.linesDone ?? []), index])];
        if ((g.lineCursor ?? 0) === index) g.lineCursor = Math.min(index + 1, this.script().lines.length);
        break;
      }

      case 'lineCancel': {
        phase('recording');
        const g = this.myGroupOrThrow(me.id);
        if (g.lineTake?.by === me.id) delete g.lineTake;
        break;
      }

      case 'finishRecording':
        host();
        phase('recording', 'mixing');
        s.phase = 'mixing';
        this.requestAllMixes();
        break;

      case 'rate': {
        phase('screening');
        const r = s.round!;
        const pos = r.screeningOrder.indexOf(action.groupId);
        if (pos < 0 || pos > r.screeningIndex) throw new GameError('Bu grup henüz izlenmedi');
        r.ratings[action.groupId] ??= {};
        r.ratings[action.groupId][me.id] = clampInt(action.stars, 1, 5);
        break;
      }

      case 'screenReady': {
        phase('screening');
        const r = s.round!;
        if (action.seq !== r.screenSeq || r.screeningStartAt) break;
        const ready = [...new Set([...(r.screenReady ?? []), me.id])];
        r.screenReady = ready;
        if (s.players.every((p) => !this.isConnected(p.id) || ready.includes(p.id))) this.startScreening(r.screenSeq);
        break;
      }

      case 'replayScreening':
        host();
        phase('screening');
        this.beginScreening();
        break;

      case 'nextScreening': {
        host();
        phase('screening');
        const r = s.round!;
        if (r.screeningIndex >= r.screeningOrder.length - 1) throw new GameError('Bu son gruptu');
        r.screeningIndex += 1;
        this.beginScreening();
        break;
      }

      case 'showResults':
        host();
        phase('screening');
        this.showResults();
        break;

      case 'nextRound': {
        host();
        phase('results');
        const old = s.round;
        if (old) fs.rmSync(path.join(config.recordingsDir, old.id), { recursive: true, force: true });
        s.round = null;
        s.phase = 'submit';
        break;
      }

      default:
        throw new GameError('Bilinmeyen işlem');
    }
    this.changed();
    return result;
  }

  private script(): Script {
    const script = this.state.round?.script;
    if (!script) throw new GameError('Senaryo hazır değil');
    return script;
  }

  private myGroupOrThrow(playerId: string): Group {
    const g = this.state.round?.groups.find((x) => x.members.includes(playerId));
    if (!g) throw new GameError('Bu turda bir grupta değilsin');
    return g;
  }

  private group(id: string): Group {
    const g = this.state.round?.groups.find((x) => x.id === id);
    if (!g) throw new GameError('Grup bulunamadı');
    return g;
  }

  // ---------------------------------------------------------------- submit & vote

  private submitVideo(me: Player, a: Extract<Action, { type: 'submitVideo' }>): void {
    const youtubeId = parseYouTubeId(String(a.url ?? ''));
    if (!youtubeId) throw new GameError('Bu bir YouTube linki gibi görünmüyor');
    const start = Math.max(0, Number(a.start) || 0);
    const end = Number(a.end);
    if (!Number.isFinite(end) || end <= start + 1) throw new GameError('Bitiş, başlangıçtan sonra olmalı');
    if (end - start > config.maxClipSeconds)
      throw new GameError(`Klip en fazla ${config.maxClipSeconds} saniye olabilir`);
    const lang: Lang = a.lang === 'en' ? 'en' : 'tr';
    const speakers = clampInt(a.speakers, 1, MAX_SPEAKERS);
    const sub: Submission = {
      id: randomUUID(),
      playerId: me.id,
      youtubeId,
      title: 'YouTube videosu',
      start: Math.round(start * 10) / 10,
      end: Math.round(end * 10) / 10,
      speakers,
      lang,
      createdAt: Date.now(),
    };
    // one video per player in the pool: a new one replaces the old
    this.state.submissions = this.state.submissions.filter((x) => x.playerId !== me.id);
    this.state.submissions.push(sub);
    void fetchTitle(youtubeId).then((title) => {
      if (title) {
        sub.title = title;
        this.changed();
      }
    });
  }

  private openVoting(): void {
    const s = this.state;
    if (!s.submissions.length) throw new GameError('Önce en az bir video gönderilmeli');
    s.roundCounter += 1;
    s.round = {
      id: randomUUID(),
      number: s.roundCounter,
      votes: {},
      groups: [],
      screeningOrder: [],
      screeningIndex: 0,
      ratings: {},
    };
    s.phase = 'vote';
    if (s.submissions.length === 1) this.closeVoting();
  }

  private everyoneVoted(): boolean {
    const r = this.state.round!;
    const voters = this.state.players.filter(
      (p) => this.isConnected(p.id) && this.state.submissions.some((x) => x.playerId !== p.id),
    );
    return voters.length > 0 && voters.every((p) => r.votes[p.id]);
  }

  private closeVoting(): void {
    const s = this.state;
    const r = s.round!;
    const tally: Record<string, number> = {};
    for (const sub of s.submissions) tally[sub.id] = 0;
    for (const subId of Object.values(r.votes)) if (subId in tally) tally[subId] += 1;
    const top = Math.max(...Object.values(tally));
    const leaders = s.submissions.filter((x) => tally[x.id] === top);
    const winner = shuffle(leaders)[0];
    r.voteTally = tally;
    r.submission = winner;
    s.played = [...(s.played ?? []).filter((id) => id !== winner.youtubeId), winner.youtubeId].slice(-300);
    s.submissions = s.submissions.filter((x) => x.id !== winner.id);
    const owner = this.player(winner.playerId);
    if (owner) owner.score += SELECTION_BONUS;
    this.startProcessing();
    // work done ahead of time on other videos makes way for the winner; the pool is queued again after it
    s.jobs = s.jobs.filter((j) => !j.prep);
    this.prefetch();
  }

  // ---------------------------------------------------------------- processing ahead of time

  private fastWorkerOnline(): boolean {
    const now = Date.now();
    return [...this.workers.values()].some((w) => w.fast && now - w.lastSeen < WORKER_ONLINE_MS);
  }

  /** The video with the most votes so far (ties: the one submitted first). */
  private voteLeader(): Submission | undefined {
    const r = this.state.round;
    if (this.state.phase !== 'vote' || !r) return undefined;
    const tally = new Map<string, number>();
    for (const id of Object.values(r.votes)) tally.set(id, (tally.get(id) ?? 0) + 1);
    let best: Submission | undefined;
    let top = 0;
    for (const sub of this.state.submissions) {
      const n = tally.get(sub.id) ?? 0;
      if (n > top) {
        top = n;
        best = sub;
      }
    }
    return best;
  }

  private clipCached(sub: Submission): boolean {
    const dir = path.join(config.clipsDir, clipKey(sub));
    return fs.existsSync(path.join(dir, 'clip.mp4')) && fs.existsSync(path.join(dir, 'script.json'));
  }

  private newJob(sub: Submission, prep?: Job['prep']): Job {
    return {
      id: randomUUID(),
      key: clipKey(sub),
      youtubeId: sub.youtubeId,
      url: watchUrl(sub.youtubeId),
      start: sub.start,
      end: sub.end,
      lang: sub.lang,
      speakers: sub.speakers,
      status: 'queued',
      updatedAt: Date.now(),
      prep,
    };
  }

  /**
   * Processes likely winners before the vote ends, so the script is ready sooner: the video leading
   * the vote (even on the phone), and with a fast worker online every video in the pool. Only one
   * leader job waits in the queue at a time, so a changing lead doesn't pile up work on the phone.
   */
  private prefetch(): boolean {
    const s = this.state;
    let changed = false;
    const pool = new Set(s.submissions.map(clipKey));
    const leader = this.voteLeader();
    const leaderKey = leader ? clipKey(leader) : undefined;
    s.jobs = s.jobs.filter((j) => {
      const stale = j.prep && j.status === 'queued' && (!pool.has(j.key) || (j.prep === 'leader' && j.key !== leaderKey));
      if (stale) changed = true;
      return !stale;
    });
    const wanted: [Submission, NonNullable<Job['prep']>][] = [];
    if (leader) wanted.push([leader, 'leader']);
    if (this.fastWorkerOnline()) for (const sub of s.submissions) wanted.push([sub, 'pool']);
    for (const [sub, prep] of wanted) {
      const key = clipKey(sub);
      if (this.failedPrep.has(key)) continue;
      const existing = s.jobs.find((j) => j.key === key);
      if (existing) {
        if (prep === 'leader' && existing.prep === 'pool') {
          existing.prep = 'leader';
          changed = true;
        }
        continue;
      }
      if (this.clipCached(sub)) continue;
      s.jobs.push(this.newJob(sub, prep));
      changed = true;
    }
    return changed;
  }

  // ---------------------------------------------------------------- processing jobs

  private startProcessing(): void {
    const s = this.state;
    const r = s.round!;
    const sub = r.submission!;
    const key = clipKey(sub);
    const dir = path.join(config.clipsDir, key);
    const scriptFile = path.join(dir, 'script.json');
    if (fs.existsSync(path.join(dir, 'clip.mp4')) && fs.existsSync(scriptFile)) {
      try {
        const script = JSON.parse(fs.readFileSync(scriptFile, 'utf8')) as Script;
        // picked again: counts as recently used, so the cleanup keeps it
        const nowDate = new Date();
        fs.utimesSync(path.join(dir, 'clip.mp4'), nowDate, nowDate);
        r.clip = { key, status: 'ready', stage: 'done', progress: 1, duration: script.duration };
        r.script = this.normalizeScript(script, sub.speakers);
        s.phase = 'script';
        return;
      } catch {
        // fall through and process again
      }
    }
    this.failedPrep.delete(key);
    let job = s.jobs.find((j) => j.key === key);
    if (job) delete job.prep; // already being worked on ahead of time: now it is needed
    else {
      job = this.newJob(sub);
      s.jobs.push(job);
    }
    const running = job.status === 'claimed';
    r.clip = {
      key,
      status: running ? 'processing' : 'queued',
      stage: running ? job.stage ?? 'download' : 'queued',
      progress: running ? job.progress ?? 0 : 0,
      jobId: job.id,
      workerName: running ? job.claimedBy : undefined,
    };
    s.phase = 'processing';
  }

  private normalizeScript(raw: Script, speakers: number): Script {
    const count = Math.max(1, Math.min(MAX_SPEAKERS, speakers));
    const characters = Array.from({ length: count }, (_, id) => ({
      id,
      name: raw.characters?.find((c) => c.id === id)?.name ?? `Karakter ${id + 1}`,
    }));
    const lines: ScriptLine[] = (raw.lines ?? [])
      .filter((l) => Number.isFinite(l.start) && Number.isFinite(l.end) && String(l.text ?? '').trim())
      .map((l) => ({
        id: randomUUID().slice(0, 8),
        start: Number(l.start),
        end: Number(l.end),
        speaker: Math.min(count - 1, Math.max(0, Math.round(Number(l.speaker) || 0))),
        text: String(l.text).trim(),
        words: Array.isArray(l.words) ? l.words : undefined,
      }))
      .sort((a, b) => a.start - b.start);
    return { language: raw.language ?? '', duration: Number(raw.duration) || 0, characters, lines };
  }

  nextJob(name: string, fast: boolean, canPlaylist = false): WorkerJob | PlaylistTask | null {
    const now = Date.now();
    this.workers.set(name, { lastSeen: now, fast });
    const s = this.state;
    if (this.prefetch()) this.changed();
    const pl = s.playlist;
    // listing a playlist takes a second or two, so whichever worker asks first does it
    if (canPlaylist && pl?.taskId && (!pl.claimedAt || now - pl.claimedAt > PLAYLIST_TASK_MS)) {
      pl.claimedAt = now;
      return { kind: 'playlist', id: pl.taskId, url: pl.url };
    }
    if (!fast) {
      const fastOnline = [...this.workers.entries()].some(([n, w]) => n !== name && w.fast && now - w.lastSeen < WORKER_ONLINE_MS);
      if (fastOnline) return null; // leave the job for the faster machine
    }
    // needed-now first, then the vote leader, then the rest of the pool (fast workers only)
    const rank = (j: Job) => (j.prep === undefined ? 0 : j.prep === 'leader' ? 1 : 2);
    const job = s.jobs
      .filter((j) => (j.status === 'queued' || now - j.updatedAt > STALE_JOB_MS) && (fast || j.prep !== 'pool'))
      .sort((a, b) => rank(a) - rank(b))[0];
    if (!job) return null;
    job.status = 'claimed';
    job.claimedBy = name;
    job.updatedAt = now;
    const clip = s.round?.clip;
    if (clip?.jobId === job.id) {
      clip.status = 'processing';
      clip.stage = 'download';
      clip.progress = 0;
      clip.workerName = name;
      delete clip.error;
    }
    this.changed();
    const { id, youtubeId, url, start, end, lang, speakers } = job;
    return { kind: 'clip', id, youtubeId, url, start, end, lang, speakers };
  }

  /** A worker's answer to a playlist task: the videos, or why the list could not be read. */
  playlistResult(taskId: string, body: { title?: unknown; items?: unknown; error?: unknown }): void {
    const pl = this.state.playlist;
    if (!pl || pl.taskId !== taskId) return; // the host changed the list meanwhile
    delete pl.taskId;
    delete pl.claimedAt;
    if (body.error !== undefined && body.error !== null) {
      pl.status = pl.items.length ? 'ready' : 'error';
      pl.error = cleanText(body.error, 300) || 'Liste okunamadı';
    } else {
      const seen = new Set<string>();
      const items: Suggestion[] = [];
      for (const raw of Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : []) {
        const id = parseYouTubeId(String(raw?.youtubeId ?? ''));
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const d = Number(raw.duration);
        items.push({
          youtubeId: id,
          title: cleanText(raw.title, 120) || 'YouTube videosu',
          duration: Number.isFinite(d) && d > 0 ? Math.round(d * 10) / 10 : null,
        });
      }
      pl.items = items.slice(0, 1000);
      pl.title = cleanText(body.title, 120) || undefined;
      pl.readAt = Date.now();
      pl.status = items.length ? 'ready' : 'error';
      if (items.length) delete pl.error;
      else pl.error = 'Listede oynatılabilir video bulunamadı';
    }
    this.changed();
  }

  /**
   * Two random videos from the playlist: preferably not in the pool, not played yet and not shown
   * to this player before. When those run out, it falls back step by step.
   */
  private suggest(exclude: string[]): SuggestResult {
    const pl = this.state.playlist;
    if (!pl?.items.length) throw new GameError('Öneri listesi hazır değil');
    const pooled = new Set(this.state.submissions.map((x) => x.youtubeId));
    const played = new Set(this.state.played ?? []);
    const shown = new Set(exclude.slice(-200));
    const lastShown = new Set(exclude.slice(-2));
    const tiers = [
      pl.items.filter((x) => !pooled.has(x.youtubeId) && !played.has(x.youtubeId) && !shown.has(x.youtubeId)),
      pl.items.filter((x) => !pooled.has(x.youtubeId) && !played.has(x.youtubeId) && !lastShown.has(x.youtubeId)),
      pl.items.filter((x) => !pooled.has(x.youtubeId) && !lastShown.has(x.youtubeId)),
      pl.items.filter((x) => !lastShown.has(x.youtubeId)),
      pl.items,
    ];
    const tier = tiers.find((t) => t.length >= 2) ?? pl.items;
    return { items: shuffle(tier).slice(0, 2) };
  }

  /** Looks up a job; any call about it also proves its worker is still alive. */
  private job(id: string): Job {
    const job = this.state.jobs.find((j) => j.id === id);
    if (!job) throw new JobGone('İş bulunamadı');
    if (job.claimedBy) {
      const w = this.workers.get(job.claimedBy);
      this.workers.set(job.claimedBy, { lastSeen: Date.now(), fast: w?.fast ?? false });
    }
    return job;
  }

  jobProgress(id: string, stage: unknown, progress: unknown): void {
    const job = this.job(id);
    job.updatedAt = Date.now();
    job.stage = String(stage ?? job.stage ?? '');
    job.progress = Math.min(1, Math.max(0, Number(progress) || 0));
    const clip = this.state.round?.clip;
    if (clip?.jobId === id) {
      clip.status = 'processing';
      clip.stage = String(stage ?? clip.stage);
      clip.progress = Math.min(1, Math.max(0, Number(progress) || 0));
      this.changed();
    }
  }

  jobUploadPath(id: string): string {
    const job = this.job(id);
    const dir = path.join(config.clipsDir, job.key);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'clip.mp4.part');
  }

  jobDone(id: string, script: Script): void {
    const job = this.job(id);
    const dir = path.join(config.clipsDir, job.key);
    const part = path.join(dir, 'clip.mp4.part');
    if (!fs.existsSync(part)) throw new GameError('Önce video yüklenmeli');
    fs.renameSync(part, path.join(dir, 'clip.mp4'));
    fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script));
    this.state.jobs = this.state.jobs.filter((j) => j.id !== id);
    const r = this.state.round;
    if (r?.clip?.jobId === id && r.submission) {
      r.clip = { key: job.key, status: 'ready', stage: 'done', progress: 1, duration: script.duration, workerName: job.claimedBy };
      r.script = this.normalizeScript(script, r.submission.speakers);
      if (this.state.phase === 'processing') this.state.phase = 'script';
    }
    this.changed();
  }

  jobFail(id: string, error: unknown): void {
    const job = this.job(id);
    if (job.prep) this.failedPrep.add(job.key);
    this.state.jobs = this.state.jobs.filter((j) => j.id !== id);
    const clip = this.state.round?.clip;
    if (clip?.jobId === job.id) {
      clip.status = 'error';
      clip.error = cleanText(error, 500) || 'Bilinmeyen hata';
    }
    this.changed();
  }

  /** What the storage cleanup must not delete: clips in use or queued, and the current round. */
  inUse(): { clipKeys: Set<string>; roundIds: Set<string> } {
    const clipKeys = new Set(this.state.jobs.map((j) => j.key));
    if (this.state.round?.clip) clipKeys.add(this.state.round.clip.key);
    const roundIds = new Set(this.state.round ? [this.state.round.id] : []);
    return { clipKeys, roundIds };
  }

  private workerOnline(): boolean {
    const now = Date.now();
    return [...this.workers.values()].some((w) => now - w.lastSeen < WORKER_ONLINE_MS);
  }

  // ---------------------------------------------------------------- casting & recording

  private openCasting(): void {
    const s = this.state;
    const r = s.round!;
    const script = this.script();
    const players = s.players.filter((p) => this.isConnected(p.id)).map((p) => p.id);
    if (!players.length) throw new GameError('Bağlı oyuncu yok');
    const loads = characterLoads(script);
    r.groups = makeGroups(players, script.characters.length).map((members, index) => {
      const roles = distributeRoles(members, loads);
      return {
        id: randomUUID(),
        index,
        members,
        roles,
        effects: defaultEffects(roles, loads),
        ready: [],
        recordings: {},
        mixStatus: 'none',
        mixVersion: 0,
      };
    });
    s.phase = 'casting';
  }

  saveRecording(playerId: string, secret: string, roundId: string, trimMs: number, ext: string, tmpFile: string): void {
    if (!this.auth(playerId, secret)) throw new GameError('Yetkisiz');
    const r = this.state.round;
    if (!r || r.id !== roundId || this.state.phase !== 'recording') throw new GameError('Kayıt zamanı geçti');
    const g = r.groups.find((x) => x.members.includes(playerId));
    if (!g) throw new GameError('Bu turda bir grupta değilsin');
    const dir = path.join(config.recordingsDir, r.id);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) if (f.startsWith(`${playerId}.`)) fs.rmSync(path.join(dir, f), { force: true });
    const file = path.join(dir, `${playerId}.${ext}`);
    fs.renameSync(tmpFile, file);
    g.recordings[playerId] = { file, trimMs: Math.max(-5000, Math.min(5000, Math.round(trimMs) || 0)), uploadedAt: Date.now() };

    if (this.groupComplete(g)) this.requestMix(g);
    if (r.groups.every((x) => this.groupComplete(x))) {
      this.state.phase = 'mixing';
      this.requestAllMixes();
    }
    this.changed();
  }

  /** Every member who voices at least one character has uploaded a take. */
  private groupComplete(g: Group): boolean {
    const voices = new Set(Object.values(g.roles));
    return [...voices].every((p) => g.recordings[p]);
  }

  private requestAllMixes(): void {
    const r = this.state.round;
    if (!r) return;
    for (const g of r.groups) {
      // a group that sent nothing (e.g. a latecomer who left) is not screened as plain music
      if (!Object.keys(g.recordings).length) {
        g.mixStatus = 'error';
        g.mixError = 'Bu grup kayıt göndermedi';
        continue;
      }
      if (g.mixStatus === 'none' || g.mixStatus === 'error') this.requestMix(g);
    }
    this.checkMixingDone();
  }

  private requestMix(g: Group): void {
    if (g.mixStatus === 'mixing') {
      g.mixDirty = true;
      return;
    }
    g.mixStatus = 'mixing';
    delete g.mixError;
    const roundId = this.state.round!.id;
    this.mixChain = this.mixChain.then(() => this.runMix(roundId, g.id));
    this.changed();
  }

  /** One player's recording with their characters' effects, or null if they voice nobody. */
  private trackFor(script: Script, g: Group, member: string, file: string, trimMs: number): Track | null {
    const parts = characterLoads(script)
      .filter((c) => g.roles[c.id] === member)
      .sort((a, b) => b.load - a.load || a.id - b.id)
      .map((c) => ({
        characterId: c.id,
        effect: g.effects[c.id] ?? 'normal',
        segments: script.lines.filter((l) => l.speaker === c.id).map((l) => [l.start, l.end] as [number, number]),
      }));
    return parts.length ? { file, trimMs, parts } : null;
  }

  /**
   * Renders a private preview of one player's take with their effects over the music, without
   * submitting it. Returns the video URL.
   */
  async renderPreview(playerId: string, secret: string, roundId: string, trimMs: number, ext: string, tmpFile: string): Promise<string> {
    if (!this.auth(playerId, secret)) throw new GameError('Yetkisiz');
    const r = this.state.round;
    if (!r || r.id !== roundId || this.state.phase !== 'recording' || !r.script || !r.clip) throw new GameError('Kayıt zamanı geçti');
    const g = r.groups.find((x) => x.members.includes(playerId));
    if (!g) throw new GameError('Bu turda bir grupta değilsin');
    const dir = path.join(config.recordingsDir, r.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `preview-${playerId}.${ext}`);
    fs.renameSync(tmpFile, file);
    const track = this.trackFor(r.script, g, playerId, file, Math.max(-5000, Math.min(5000, Math.round(trimMs) || 0)));
    if (!track) throw new GameError('Bu grupta rolün yok');
    const clipFile = path.join(config.clipsDir, r.clip.key, 'clip.mp4');
    const outName = `preview-${playerId}.mp4`;
    const run = this.mixChain.then(() => mixGroup(clipFile, { video: path.join(config.mixesDir, r.id, outName) }, [track]));
    this.mixChain = run.catch(() => {});
    await run;
    return `/media/mixes/${r.id}/${outName}?v=${Date.now()}`;
  }

  private async runMix(roundId: string, groupId: string): Promise<void> {
    const r = this.state.round;
    const g = r?.groups.find((x) => x.id === groupId);
    if (!r || r.id !== roundId || !g || !r.script || !r.clip) return;
    g.mixDirty = false;
    const tracks: Track[] = [];
    for (const member of g.members) {
      const rec = g.recordings[member];
      if (!rec || !fs.existsSync(rec.file)) continue;
      const track = this.trackFor(r.script, g, member, rec.file, rec.trimMs);
      if (track) tracks.push(track);
    }
    const clipFile = path.join(config.clipsDir, r.clip.key, 'clip.mp4');
    const dir = path.join(config.mixesDir, r.id);
    try {
      await mixGroup(clipFile, { video: path.join(dir, `${g.id}.mp4`), audio: path.join(dir, `${g.id}.m4a`) }, tracks);
      g.mixStatus = 'ready';
      g.mixVersion += 1;
    } catch (e) {
      console.error('mix hatası', e);
      g.mixStatus = 'error';
      g.mixError = e instanceof Error ? e.message.slice(0, 400) : String(e);
    }
    if (g.mixDirty) {
      g.mixStatus = 'none';
      this.requestMix(g);
    }
    this.checkMixingDone();
    this.changed();
  }

  private checkMixingDone(): void {
    const s = this.state;
    const r = s.round;
    if (s.phase !== 'mixing' || !r) return;
    if (r.groups.some((g) => g.mixStatus === 'mixing' || g.mixStatus === 'none')) return;
    const ready = r.groups.filter((g) => g.mixStatus === 'ready');
    if (!ready.length) return; // all failed: host sees the errors and can retry
    r.screeningOrder = shuffle(ready.map((g) => g.id));
    r.screeningIndex = 0;
    s.phase = 'screening';
    this.beginScreening();
  }

  /** A group's screening starts once everyone's player has loaded, or after SCREEN_WAIT_MS. */
  private beginScreening(): void {
    const r = this.state.round!;
    r.screenSeq = (r.screenSeq ?? 0) + 1;
    r.screenReady = [];
    delete r.screeningStartAt;
    const seq = r.screenSeq;
    clearTimeout(this.screenTimer);
    this.screenTimer = setTimeout(() => this.startScreening(seq), SCREEN_WAIT_MS);
    this.screenTimer.unref?.();
  }

  private startScreening(seq: number): void {
    const r = this.state.round;
    if (this.state.phase !== 'screening' || !r || r.screenSeq !== seq || r.screeningStartAt) return;
    clearTimeout(this.screenTimer);
    r.screeningStartAt = Date.now() + SCREEN_COUNTDOWN_MS;
    this.changed();
  }

  // ---------------------------------------------------------------- results

  private showResults(): void {
    const s = this.state;
    const r = s.round!;
    const results: GroupResult[] = r.screeningOrder.map((groupId) => {
      const vals = Object.values(r.ratings[groupId] ?? {});
      const average = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      return { groupId, average: Math.round(average * 100) / 100, count: vals.length };
    });
    results.sort((a, b) => b.average - a.average);
    const best = results[0]?.average ?? 0;
    r.results = results;
    r.winnerGroupIds = best > 0 ? results.filter((x) => x.average === best).map((x) => x.groupId) : [];
    for (const res of results) {
      const g = r.groups.find((x) => x.id === res.groupId);
      for (const m of g?.members ?? []) {
        const p = this.player(m);
        if (p) p.score = Math.round((p.score + res.average) * 100) / 100;
      }
    }
    s.phase = 'results';
  }

  // ---------------------------------------------------------------- views

  view(playerId: string | null): GameView {
    const s = this.state;
    const me = playerId ? this.player(playerId) : undefined;
    const pv = (p: Player): PlayerView => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      score: p.score,
      connected: this.isConnected(p.id),
      color: p.color,
      avatar: p.avatar,
    });
    const sv = (x: Submission): SubmissionView => ({
      id: x.id,
      playerId: x.playerId,
      youtubeId: x.youtubeId,
      title: x.title,
      start: x.start,
      end: x.end,
      speakers: x.speakers,
      lang: x.lang,
    });
    return {
      phase: s.phase,
      serverNow: Date.now(),
      me: me ? pv(me) : null,
      players: s.players.map(pv),
      submissions: s.submissions.map(sv),
      round: s.round ? this.roundView(s.round, me?.id ?? null, sv) : null,
      workerOnline: this.workerOnline(),
      passwordRequired: !!config.gamePassword,
      maxClipSeconds: config.maxClipSeconds,
      publicUrl: config.publicUrl || null,
      playlist: s.playlist
        ? {
            url: s.playlist.url,
            title: s.playlist.title,
            status: s.playlist.status,
            error: s.playlist.error,
            count: s.playlist.items.length,
          }
        : null,
    };
  }

  private roundView(r: Round, meId: string | null, sv: (x: Submission) => SubmissionView): RoundView {
    const phase = this.state.phase;
    const screenedUpTo = phase === 'results' ? r.screeningOrder.length - 1 : phase === 'screening' ? r.screeningIndex : -1;
    const groups: GroupView[] = r.groups.map((g) => {
      const pos = r.screeningOrder.indexOf(g.id);
      const visible = (meId && g.members.includes(meId)) || (pos >= 0 && pos <= screenedUpTo);
      // the next group's sound may preload during rating; it is not shown anywhere until its turn
      const preload = phase === 'screening' && pos === r.screeningIndex + 1;
      const ready = g.mixStatus === 'ready';
      return {
        id: g.id,
        index: g.index,
        members: g.members,
        roles: g.roles,
        effects: g.effects,
        ready: g.ready,
        recorded: Object.keys(g.recordings),
        mixStatus: g.mixStatus,
        mixError: g.mixError,
        mixUrl: visible && ready ? `/media/mixes/${r.id}/${g.id}.mp4?v=${g.mixVersion}` : undefined,
        mixAudioUrl: (visible || preload) && ready ? `/media/mixes/${r.id}/${g.id}.m4a?v=${g.mixVersion}` : undefined,
        takeStartAt: g.takeStartAt,
        lineCursor: g.lineCursor ?? 0,
        lineTake: r.script && lineTakeActive(g, r.script) ? g.lineTake : undefined,
        linesDone: g.linesDone ?? [],
      };
    });
    const ratedBy: Record<string, string[]> = {};
    const myRatings: Record<string, number> = {};
    for (const [gid, map] of Object.entries(r.ratings)) {
      ratedBy[gid] = Object.keys(map);
      if (meId && map[meId]) myRatings[gid] = map[meId];
    }
    const clip: ClipView | undefined = r.clip && {
      status: r.clip.status,
      stage: r.clip.stage,
      progress: r.clip.progress,
      error: r.clip.error,
      duration: r.clip.duration,
      workerName: r.clip.workerName,
      videoUrl: r.clip.status === 'ready' ? `/media/clips/${r.clip.key}/clip.mp4` : undefined,
    };
    return {
      id: r.id,
      number: r.number,
      submissionId: r.submission?.id,
      submission: r.submission ? sv(r.submission) : undefined,
      votedPlayerIds: Object.keys(r.votes),
      myVote: meId ? r.votes[meId] : undefined,
      voteTally: phase === 'vote' ? undefined : r.voteTally,
      clip,
      script: r.script,
      groups,
      screeningOrder: r.screeningOrder,
      screeningIndex: r.screeningIndex,
      screeningStartAt: r.screeningStartAt,
      screenSeq: r.screenSeq ?? 0,
      screenReadyCount: r.screenReady?.length ?? 0,
      ratedBy,
      myRatings,
      results: phase === 'results' ? r.results : undefined,
      winnerGroupIds: phase === 'results' ? r.winnerGroupIds : undefined,
    };
  }
}
