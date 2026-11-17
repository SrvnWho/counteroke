// Little nudges for players who are looking at another tab or their voice chat: a chime, a buzz on
// phones and a blinking tab title when something needs them (their line, the gala...).
import { useEffect, useRef, useState } from 'react';
import type { GameView, Phase } from '../../shared/types.ts';
import { toast } from './net.ts';
import { audioCtx } from './recorder.ts';
import { myGroup, playerName } from './util.ts';

const SOUND_KEY = 'counteroke.sound';
const TITLE = 'counteroke';

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function useSoundSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(soundEnabled);
  const set = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(SOUND_KEY, v ? 'on' : 'off');
    } catch {
      /* ignore */
    }
    if (v) chime('soft');
  };
  return [on, set];
}

/** Two short tones made on the fly (no sound files to download). */
export function chime(kind: 'turn' | 'soft' = 'soft'): void {
  if (!soundEnabled()) return;
  try {
    const c = audioCtx();
    const notes = kind === 'turn' ? [880, 1320] : [660, 990];
    notes.forEach((f, i) => {
      const at = c.currentTime + i * 0.13;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(kind === 'turn' ? 0.3 : 0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
      osc.connect(gain).connect(c.destination);
      osc.start(at);
      osc.stop(at + 0.3);
    });
  } catch {
    /* audio not available: the title and toast still work */
  }
}

let restoreTitle: (() => void) | null = null;

/** Blinks the tab title until the player looks at the tab again. */
function flashTitle(msg: string): void {
  if (!document.hidden) return;
  restoreTitle?.();
  let on = true;
  document.title = `🔔 ${msg}`;
  const id = window.setInterval(() => {
    on = !on;
    document.title = on ? `🔔 ${msg}` : TITLE;
  }, 1000);
  const back = () => {
    if (document.hidden) return;
    restoreTitle?.();
  };
  restoreTitle = () => {
    window.clearInterval(id);
    document.title = TITLE;
    document.removeEventListener('visibilitychange', back);
    restoreTitle = null;
  };
  document.addEventListener('visibilitychange', back);
}

function nudge(msg: string, kind: 'turn' | 'soft' = 'soft'): void {
  chime(kind);
  // browsers refuse to vibrate before the player has tapped the page
  if (kind === 'turn' && navigator.userActivation?.hasBeenActive) navigator.vibrate?.([120, 80, 120]);
  flashTitle(msg);
}

const PHASE_ALERTS: Partial<Record<Phase, string>> = {
  vote: 'Oylama başladı',
  script: 'Video hazır, senaryo masası açıldı',
  casting: 'Roller dağıtıldı',
  recording: 'Kayıt başladı',
  results: 'Sonuçlar açıklandı',
};

/** Watches the game state and nudges the player when something needs them. */
export function useAlerts(g: GameView | null): void {
  const prev = useRef<{ phase?: Phase; turnKey?: string; members?: string[]; screenSeq?: number }>({});
  useEffect(() => {
    if (!g?.me) return;
    const p = prev.current;
    const me = g.me.id;

    if (p.phase && p.phase !== g.phase && PHASE_ALERTS[g.phase]) nudge(PHASE_ALERTS[g.phase]!);

    // gala: each group's film is about to start
    const r = g.round;
    if (g.phase === 'screening' && r?.screeningStartAt && r.screenSeq !== p.screenSeq) {
      p.screenSeq = r.screenSeq;
      nudge('Gala başlıyor');
    }

    const group = myGroup(g);
    // "Sıra sende": the group is on a line this player voices and nobody is recording
    let turnKey: string | undefined;
    if (g.phase === 'recording' && group && r?.script && !group.lineTake) {
      const line = r.script.lines[group.lineCursor];
      if (line && group.roles[line.speaker] === me) turnKey = `${r.id}:${group.lineCursor}`;
    }
    if (turnKey && turnKey !== p.turnKey && recordingInLines()) nudge('Sıra sende!', 'turn');
    p.turnKey = turnKey;

    // a latecomer joined this player's group: roles were dealt again
    const members = group?.members ?? [];
    if (p.members && (g.phase === 'casting' || g.phase === 'recording')) {
      const joined = members.filter((m) => m !== me && !p.members!.includes(m));
      if (joined.length && p.members.includes(me)) {
        toast(`${joined.map((m) => playerName(g, m)).join(', ')} grubunuza katıldı, roller yeniden dağıtıldı`);
        chime();
      }
    }
    p.members = members;
    p.phase = g.phase;
  }, [g]);
}

function recordingInLines(): boolean {
  try {
    return localStorage.getItem('counteroke.recMode') !== 'full';
  } catch {
    return true;
  }
}
