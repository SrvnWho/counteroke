import { io } from 'socket.io-client';
import type { Ack, Action, JoinResult } from '../../shared/types.ts';

export const socket = io({ autoConnect: true, transports: ['websocket', 'polling'] });

// ---------------------------------------------------------------- server clock

let clockOffset = 0; // serverTime - Date.now()

/** Current time on the server's clock, in ms. Used to start videos in sync. */
export function serverNow(): number {
  return Date.now() + clockOffset;
}

function ping(): Promise<{ rtt: number; offset: number }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    socket.timeout(3000).emit('time', (err: Error | null, server: number) => {
      if (err) return reject(err);
      const t1 = Date.now();
      resolve({ rtt: t1 - t0, offset: server - (t0 + t1) / 2 });
    });
  });
}

async function syncClock(): Promise<void> {
  const samples: { rtt: number; offset: number }[] = [];
  for (let i = 0; i < 5; i++) {
    try {
      samples.push(await ping());
    } catch {
      /* ignore */
    }
  }
  if (samples.length) clockOffset = samples.sort((a, b) => a.rtt - b.rtt)[0].offset;
}

setInterval(() => socket.connected && void syncClock(), 30_000);

// ---------------------------------------------------------------- session

const SESSION_KEY = 'counteroke.session';

export interface Session {
  playerId: string;
  secret: string;
}

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function setSession(s: Session | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode: the session just won't survive a reload */
  }
}

socket.on('connect', () => {
  void syncClock();
  const s = getSession();
  if (s) {
    socket.emit('hello', s, (ack: Ack) => {
      if (!ack.ok) setSession(null);
    });
  }
});

export function join(name: string, password: string, avatar?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.timeout(10_000).emit('join', { name, password, avatar }, (err: Error | null, ack: Ack<JoinResult>) => {
      if (err) return reject(new Error('Sunucu cevap vermedi'));
      if (!ack.ok) return reject(new Error(ack.error));
      setSession(ack.data!);
      resolve();
    });
  });
}

export function send(action: Action): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.timeout(10_000).emit('action', action, (err: Error | null, ack: Ack) => {
      if (err) return reject(new Error('Sunucu cevap vermedi'));
      if (!ack.ok) return reject(new Error(ack.error));
      resolve(ack.data);
    });
  });
}

// ---------------------------------------------------------------- toasts

type ToastListener = (msg: string) => void;
const toastListeners = new Set<ToastListener>();

export function onToast(fn: ToastListener): () => void {
  toastListeners.add(fn);
  return () => toastListeners.delete(fn);
}

export function toast(msg: string): void {
  for (const fn of toastListeners) fn(msg);
}

/** Sends an action and shows any error as a toast. */
export function act(action: Action): void {
  send(action).catch((e: Error) => toast(e.message));
}
