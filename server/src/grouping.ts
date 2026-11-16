import { EXTRA_CHARACTER_EFFECTS } from '../../shared/constants.ts';
import type { EffectId } from '../../shared/constants.ts';
import type { Script } from '../../shared/types.ts';

export function shuffle<T>(items: readonly T[], rnd: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Splits players into groups the size of the character count; the leftover
 * players form a smaller last group (9 players, 4 characters -> 4 + 4 + 1).
 */
export function makeGroups(playerIds: readonly string[], size: number, rnd: () => number = Math.random): string[][] {
  const step = Math.max(1, Math.floor(size));
  const ids = shuffle(playerIds, rnd);
  const groups: string[][] = [];
  for (let i = 0; i < ids.length; i += step) groups.push(ids.slice(i, i + step));
  return groups;
}

export interface CharacterLoad {
  id: number;
  /** seconds of dialogue */
  load: number;
}

/** Seconds of dialogue per character in a script. */
export function characterLoads(script: Script): CharacterLoad[] {
  return script.characters.map((c) => ({
    id: c.id,
    load: script.lines
      .filter((l) => l.speaker === c.id)
      .reduce((sum, l) => sum + Math.max(0, l.end - l.start), 0),
  }));
}

/**
 * Hands every character to a group member. With as many members as characters
 * everyone gets one; with fewer, the longest parts are dealt first to whoever
 * has the least dialogue so far, so speaking time stays balanced.
 */
export function distributeRoles(members: readonly string[], chars: readonly CharacterLoad[]): Record<number, string> {
  const roles: Record<number, string> = {};
  if (members.length === 0) return roles;
  const load = new Map(members.map((m) => [m, 0]));
  const count = new Map(members.map((m) => [m, 0]));
  const sorted = [...chars].sort((a, b) => b.load - a.load || a.id - b.id);
  const onePerMember = members.length >= chars.length;
  for (const c of sorted) {
    let best = members[0];
    for (const m of members) {
      const better = onePerMember
        ? count.get(m)! < count.get(best)!
        : load.get(m)! < load.get(best)! || (load.get(m) === load.get(best) && count.get(m)! < count.get(best)!);
      if (better) best = m;
    }
    roles[c.id] = best;
    load.set(best, load.get(best)! + c.load);
    count.set(best, count.get(best)! + 1);
  }
  return roles;
}

/**
 * Each player's biggest part keeps their normal voice; every further part they
 * voice gets a different effect so the characters sound apart.
 */
export function defaultEffects(roles: Record<number, string>, chars: readonly CharacterLoad[]): Record<number, EffectId> {
  const effects: Record<number, EffectId> = {};
  const byPlayer = new Map<string, CharacterLoad[]>();
  for (const c of chars) {
    const p = roles[c.id];
    if (!p) continue;
    if (!byPlayer.has(p)) byPlayer.set(p, []);
    byPlayer.get(p)!.push(c);
  }
  for (const list of byPlayer.values()) {
    list.sort((a, b) => b.load - a.load || a.id - b.id);
    list.forEach((c, i) => {
      effects[c.id] = i === 0 ? 'normal' : EXTRA_CHARACTER_EFFECTS[(i - 1) % EXTRA_CHARACTER_EFFECTS.length];
    });
  }
  for (const c of chars) effects[c.id] ??= 'normal';
  return effects;
}
