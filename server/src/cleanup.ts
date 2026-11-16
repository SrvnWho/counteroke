import fs from 'node:fs';
import path from 'node:path';

export interface CleanupOptions {
  clipsDir: string;
  mixesDir: string;
  recordingsDir: string;
  /** clips and scene videos unused for longer than this are deleted; 0 keeps them forever */
  keepDays: number;
  /** clips the current round or a queued job needs */
  keepClipKeys: ReadonlySet<string>;
  /** the round being played: its recordings and videos stay */
  keepRoundIds: ReadonlySet<string>;
  now?: number;
}

export interface CleanupResult {
  clips: number;
  rounds: number;
  leftovers: number;
  bytes: number;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function entries(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Latest modification time of a file, or of anything inside a folder. */
function lastTouched(p: string): number {
  const st = fs.statSync(p);
  let t = st.mtimeMs;
  if (st.isDirectory()) {
    for (const f of entries(p)) {
      try {
        t = Math.max(t, lastTouched(path.join(p, f)));
      } catch {
        /* vanished */
      }
    }
  }
  return t;
}

function sizeOf(p: string): number {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return entries(p).reduce((sum, f) => sum + sizeOf(path.join(p, f)), 0);
}

function remove(p: string, res: CleanupResult): boolean {
  try {
    const bytes = sizeOf(p);
    fs.rmSync(p, { recursive: true, force: true });
    res.bytes += bytes;
    return true;
  } catch {
    return false; // e.g. a file that is being streamed right now; try again next time
  }
}

/** Deletes old clips, old scene videos and leftovers so the phone's storage doesn't fill up. */
export function cleanup(o: CleanupOptions): CleanupResult {
  const now = o.now ?? Date.now();
  const res: CleanupResult = { clips: 0, rounds: 0, leftovers: 0, bytes: 0 };
  const cutoff = now - o.keepDays * DAY;

  for (const key of entries(o.clipsDir)) {
    if (o.keepClipKeys.has(key)) continue;
    const dir = path.join(o.clipsDir, key);
    try {
      const hasClip = fs.existsSync(path.join(dir, 'clip.mp4'));
      const touched = lastTouched(dir);
      if (o.keepDays > 0 && touched < cutoff) {
        if (remove(dir, res)) res.clips += 1;
      } else if (!hasClip && touched < now - DAY) {
        // a processing job that never finished
        if (remove(dir, res)) res.leftovers += 1;
      }
    } catch {
      /* vanished */
    }
  }

  if (o.keepDays > 0) {
    for (const id of entries(o.mixesDir)) {
      if (o.keepRoundIds.has(id)) continue;
      const dir = path.join(o.mixesDir, id);
      try {
        if (lastTouched(dir) < cutoff && remove(dir, res)) res.rounds += 1;
      } catch {
        /* vanished */
      }
    }
  }

  for (const name of entries(o.recordingsDir)) {
    const p = path.join(o.recordingsDir, name);
    try {
      const stale = name.startsWith('upload-')
        ? fs.statSync(p).mtimeMs < now - HOUR // an upload that broke off
        : !o.keepRoundIds.has(name); // recordings of a scene that is over
      if (stale && remove(p, res)) res.leftovers += 1;
    } catch {
      /* vanished */
    }
  }

  return res;
}
