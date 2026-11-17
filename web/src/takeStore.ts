// Keeps a player's recordings in the browser (IndexedDB) until the round is over, so a page
// refresh or a dropped tab doesn't throw away takes. Every call fails quietly: without storage
// (private mode, blocked site data) recording still works, takes just aren't kept.

const DB_NAME = 'counteroke';
const STORE = 'takes';

export interface StoredTake {
  blob: Blob;
  mime: string;
  /** line takes: clip time of the take's first sample */
  at?: number;
  /** whole-clip takes: automatic latency trim */
  autoTrimMs?: number;
}

let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  opening.catch(() => {
    opening = null;
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return db()
    .then(
      (d) =>
        new Promise<T>((resolve, reject) => {
          const req = fn(d.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    )
    .catch(() => undefined);
}

export function saveTake(key: string, take: StoredTake): Promise<unknown> {
  return run('readwrite', (s) => s.put(take, key));
}

export function deleteTake(key: string): Promise<unknown> {
  return run('readwrite', (s) => s.delete(key));
}

/** All takes whose key starts with `prefix`, as [key, take] pairs. */
export async function loadTakes(prefix: string): Promise<[string, StoredTake][]> {
  const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
  const [keys, values] = await Promise.all([
    run('readonly', (s) => s.getAllKeys(range)),
    run('readonly', (s) => s.getAll(range) as IDBRequest<StoredTake[]>),
  ]);
  if (!keys || !values || keys.length !== values.length) return [];
  return keys.map((k, i) => [String(k), values[i]]);
}

/** Forgets takes from earlier rounds (keys are `${roundId}:...`). */
export async function dropOtherRounds(roundId: string): Promise<void> {
  const keys = await run('readonly', (s) => s.getAllKeys());
  for (const k of keys ?? []) if (!String(k).startsWith(`${roundId}:`)) await deleteTake(String(k));
}
