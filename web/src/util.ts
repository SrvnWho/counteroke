import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { CHARACTER_COLORS } from '../../shared/constants.ts';
import type { GameView, GroupView, PlayerView } from '../../shared/types.ts';

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function thumb(youtubeId: string): string {
  return `https://i.ytimg.com/vi/${youtubeId}/mqdefault.jpg`;
}

export function charColor(id: number): string {
  return CHARACTER_COLORS[id % CHARACTER_COLORS.length];
}

export function playerById(g: GameView, id: string): PlayerView | undefined {
  return g.players.find((p) => p.id === id);
}

export function playerName(g: GameView, id: string): string {
  return playerById(g, id)?.name ?? '?';
}

export function myGroup(g: GameView): GroupView | undefined {
  const me = g.me?.id;
  return me ? g.round?.groups.find((x) => x.members.includes(me)) : undefined;
}

export function groupLabel(group: GroupView): string {
  return `Grup ${group.index + 1}`;
}

/** File name and link that make the browser save a group's finished video. */
export function mixDownload(roundNumber: number, group: GroupView): { href: string; name: string } | null {
  if (!group.mixUrl) return null;
  const name = `counteroke-sahne${roundNumber}-grup${group.index + 1}.mp4`;
  const sep = group.mixUrl.includes('?') ? '&' : '?';
  return { href: `${group.mixUrl}${sep}download=${encodeURIComponent(name)}`, name };
}

/** Reads a video's currentTime every animation frame (timeupdate is too coarse for karaoke). */
export function useVideoTime(ref: RefObject<HTMLVideoElement | null>): number {
  const [t, setT] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    const tick = () => {
      const v = ref.current;
      if (v) setT((prev) => (Math.abs(prev - v.currentTime) > 0.02 ? v.currentTime : prev));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [ref]);
  return t;
}

export function useNow(intervalMs = 200): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function storedNumber(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && localStorage.getItem(key) !== null ? v : fallback;
  } catch {
    return fallback;
  }
}

export function storeNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}
