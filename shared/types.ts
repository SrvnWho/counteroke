// Types shared by the server and the web UI. Type-only: no runtime code here.
import type { EffectId } from './constants.ts';

export type Phase =
  | 'lobby'
  | 'submit'
  | 'vote'
  | 'processing'
  | 'script'
  | 'casting'
  | 'recording'
  | 'mixing'
  | 'screening'
  | 'results';

export type Lang = 'tr' | 'en';

export interface Word {
  w: string;
  s: number;
  e: number;
}

export interface ScriptLine {
  id: string;
  start: number;
  end: number;
  speaker: number;
  text: string;
  /** Word timings from speech-to-text. Dropped when the text is edited by hand. */
  words?: Word[];
}

export interface Character {
  id: number;
  name: string;
}

export interface Script {
  language: string;
  duration: number;
  characters: Character[];
  lines: ScriptLine[];
}

export interface PlayerView {
  id: string;
  name: string;
  isHost: boolean;
  score: number;
  connected: boolean;
  color: string;
}

export interface SubmissionView {
  id: string;
  playerId: string;
  youtubeId: string;
  title: string;
  start: number;
  end: number;
  speakers: number;
  lang: Lang;
}

export interface ClipView {
  status: 'queued' | 'processing' | 'ready' | 'error';
  stage: string;
  progress: number;
  error?: string;
  videoUrl?: string;
  duration?: number;
  workerName?: string;
}

export interface GroupView {
  id: string;
  index: number;
  members: string[];
  /** characterId -> playerId */
  roles: Record<number, string>;
  /** characterId -> effect */
  effects: Record<number, EffectId>;
  ready: string[];
  /** players whose recording has been uploaded */
  recorded: string[];
  mixStatus: 'none' | 'mixing' | 'ready' | 'error';
  mixError?: string;
  /** only visible to the group's own members, or once the group has been screened */
  mixUrl?: string;
  /** server time (ms) at which a synced group take starts */
  takeStartAt?: number;
  /** line-by-line: index (into script.lines) of the line the group is on */
  lineCursor: number;
  /** line-by-line: the line being played/recorded right now, started by its voice actor */
  lineTake?: { index: number; startAt: number; by: string };
  /** line-by-line: indexes of lines that have been recorded */
  linesDone: number[];
}

export interface GroupResult {
  groupId: string;
  average: number;
  count: number;
}

export interface RoundView {
  id: string;
  number: number;
  submissionId?: string;
  submission?: SubmissionView;
  votedPlayerIds: string[];
  myVote?: string;
  voteTally?: Record<string, number>;
  clip?: ClipView;
  script?: Script;
  groups: GroupView[];
  screeningOrder: string[];
  screeningIndex: number;
  screeningStartAt?: number;
  /** groupId -> playerIds that rated it */
  ratedBy: Record<string, string[]>;
  myRatings: Record<string, number>;
  results?: GroupResult[];
  winnerGroupIds?: string[];
}

export interface GameView {
  phase: Phase;
  serverNow: number;
  me: PlayerView | null;
  players: PlayerView[];
  submissions: SubmissionView[];
  round: RoundView | null;
  workerOnline: boolean;
  passwordRequired: boolean;
  maxClipSeconds: number;
}

/** Everything a client can ask the server to do, sent over the `action` socket event. */
export type Action =
  | { type: 'startGame' }
  | { type: 'rename'; name: string }
  | { type: 'removePlayer'; playerId: string }
  | { type: 'resetGame' }
  | { type: 'submitVideo'; url: string; start: number; end: number; speakers: number; lang: Lang }
  | { type: 'removeSubmission'; submissionId: string }
  | { type: 'openVoting' }
  | { type: 'vote'; submissionId: string }
  | { type: 'closeVoting' }
  | { type: 'retryProcessing' }
  | { type: 'backToVoting' }
  | { type: 'updateLine'; lineId: string; text?: string; speaker?: number }
  | { type: 'deleteLine'; lineId: string }
  | { type: 'renameCharacter'; characterId: number; name: string }
  | { type: 'setCharacterCount'; count: number }
  | { type: 'openCasting' }
  | { type: 'setRole'; groupId: string; characterId: number; playerId: string }
  | { type: 'setEffect'; groupId: string; characterId: number; effect: EffectId }
  | { type: 'setReady'; ready: boolean }
  | { type: 'openRecording' }
  | { type: 'groupTake' }
  | { type: 'lineGo'; index: number }
  | { type: 'lineStart' }
  | { type: 'lineDone'; index: number }
  | { type: 'lineCancel' }
  | { type: 'finishRecording' }
  | { type: 'rate'; groupId: string; stars: number }
  | { type: 'replayScreening' }
  | { type: 'nextScreening' }
  | { type: 'showResults' }
  | { type: 'nextRound' };

export type Ack<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

export interface JoinResult {
  playerId: string;
  secret: string;
}

/** A processing job handed to a worker. */
export interface WorkerJob {
  id: string;
  youtubeId: string;
  url: string;
  start: number;
  end: number;
  lang: Lang;
  speakers: number;
}
