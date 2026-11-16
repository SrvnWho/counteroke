import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(repoRoot, 'data'));

export const config = {
  port: Number(process.env.PORT ?? 3100),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir,
  clipsDir: path.join(dataDir, 'clips'),
  recordingsDir: path.join(dataDir, 'recordings'),
  mixesDir: path.join(dataDir, 'mixes'),
  stateFile: path.join(dataDir, 'state.json'),
  webDist: path.join(repoRoot, 'web', 'dist'),
  /** Shared secret the processing worker sends in the x-worker-token header. */
  workerToken: process.env.WORKER_TOKEN ?? 'counteroke-dev',
  /** Optional password players must type to join. Empty = no password. */
  gamePassword: process.env.GAME_PASSWORD ?? '',
  maxClipSeconds: Number(process.env.MAX_CLIP_SECONDS ?? 120),
  /** clips and scene videos unused this many days are deleted; 0 keeps them forever */
  keepDays: Math.max(0, Number(process.env.KEEP_DAYS ?? 7) || 0),
  ffmpeg: process.env.FFMPEG ?? 'ffmpeg',
};
