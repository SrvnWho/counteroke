import type { CSSProperties, ReactNode } from 'react';
import { AVATARS } from '../../shared/constants.ts';
import type { GameView, PlayerView } from '../../shared/types.ts';

export function Avatar({ p, size = 34 }: { g?: GameView; p: PlayerView | undefined; size?: number }) {
  if (!p) return null;
  return (
    <span
      className={`avatar ${p.connected ? '' : 'offline'}`}
      style={{ background: p.color, width: size, height: size, fontSize: Math.round(size * 0.58) }}
      title={p.name}
    >
      {p.avatar}
    </span>
  );
}

/** Grid of avatars; the ones other players already have are greyed out. */
export function AvatarPicker({
  g,
  value,
  onChange,
  selfId,
}: {
  g: GameView;
  value: string;
  onChange: (avatar: string) => void;
  /** the player choosing (their own current avatar is not "taken") */
  selfId?: string;
}) {
  const takenBy = new Map(g.players.filter((p) => p.id !== selfId).map((p) => [p.avatar, p.name]));
  return (
    <div className="avatar-picker" role="radiogroup" aria-label="Avatar">
      {AVATARS.map((a) => {
        const owner = takenBy.get(a);
        return (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={value === a}
            className={value === a ? 'on' : ''}
            disabled={!!owner}
            title={owner ? `${owner} aldı` : undefined}
            onClick={() => onChange(a)}
          >
            {a}
          </button>
        );
      })}
    </div>
  );
}

/** A random avatar nobody has yet (for the join screen). */
export function randomFreeAvatar(g: GameView, selfId?: string): string {
  const taken = new Set(g.players.filter((p) => p.id !== selfId).map((p) => p.avatar));
  const free = AVATARS.filter((a) => !taken.has(a));
  const pool = free.length ? free : AVATARS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Avatar + name in a little pill. */
export function PlayerTag({ g, id, done, children }: { g: GameView; id: string; done?: boolean; children?: ReactNode }) {
  const p = g.players.find((x) => x.id === id);
  return (
    <span className={`ptag ${done ? 'done' : ''} ${p?.connected === false ? 'offline' : ''}`}>
      <Avatar g={g} p={p} size={26} />
      <span>{p?.name ?? '?'}</span>
      {done && <span className="check">✔</span>}
      {children}
    </span>
  );
}

export function Logo({ big = false }: { big?: boolean }) {
  return (
    <div className={`logo ${big ? 'big' : ''}`} aria-label="counteroke">
      <span className="logo-mic" aria-hidden>
        🎤
      </span>
      <span className="logo-a">counter</span>
      <span className="logo-b">oke</span>
    </div>
  );
}

/** Old-film style 3-2-1 leader. `seconds` is the time left. */
export function Countdown({ seconds }: { seconds: number }) {
  const n = Math.max(1, Math.ceil(seconds));
  const sweep = (1 - (seconds - Math.floor(seconds))) * 360;
  return (
    <div className="leader" aria-live="polite">
      <div className="leader-dial" style={{ '--sweep': `${sweep}deg` } as CSSProperties}>
        <span key={n}>{n}</span>
      </div>
    </div>
  );
}

const CONFETTI = ['⭐', '🎉', '✨', '🎬', '🏆', '🎤', '💥', '🍿'];

/** Emoji confetti that rains down once. */
export function Confetti({ delay = 0 }: { delay?: number }) {
  return (
    <div className="confetti" aria-hidden>
      {Array.from({ length: 28 }, (_, i) => (
        <span
          key={i}
          style={{
            left: `${(i * 37) % 100}%`,
            animationDelay: `${delay + ((i * 13) % 20) / 10}s`,
            animationDuration: `${2.4 + ((i * 7) % 10) / 10}s`,
            fontSize: `${18 + ((i * 11) % 18)}px`,
          }}
        >
          {CONFETTI[i % CONFETTI.length]}
        </span>
      ))}
    </div>
  );
}

/** Decorative stickers floating around the join screen. */
export function Stickers() {
  const items = [
    { e: '🎬', x: '8%', y: '14%', r: -14 },
    { e: '🎞️', x: '84%', y: '10%', r: 12 },
    { e: '⭐', x: '14%', y: '72%', r: 8 },
    { e: '🍿', x: '80%', y: '68%', r: -10 },
    { e: '🎧', x: '50%', y: '6%', r: 6 },
    { e: '📼', x: '90%', y: '40%', r: 18 },
    { e: '🎙️', x: '4%', y: '44%', r: -6 },
  ];
  return (
    <div className="stickers" aria-hidden>
      {items.map((s, i) => (
        <span key={i} style={{ left: s.x, top: s.y, '--r': `${s.r}deg`, animationDelay: `${i * 0.4}s` } as CSSProperties}>
          {s.e}
        </span>
      ))}
    </div>
  );
}
