import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { GroupView, Script } from '../../shared/types.ts';
import { act, serverNow } from './net.ts';
import { encodeVoice } from './opus.ts';
import { audioCtx, decodeTake, playPreview, recordTake } from './recorder.ts';
import type { TakeHandle } from './recorder.ts';
import { dropOtherRounds, loadTakes, saveTake } from './takeStore.ts';
import { buildChunks, lineSpan, monoOf, placeTakes } from './takes.ts';

export type LinePhase = 'idle' | 'countdown' | 'recording' | 'following' | 'listening';

interface Recorded {
  samples: Float32Array;
  sampleRate: number;
  /** clip time of the take's first sample */
  at: number;
}

/**
 * Line-by-line recording, shared by the whole group: the group walks through the scene's lines
 * in order. Whoever voices the current line presses start; after a 3-2-1 the line plays for
 * everyone in the group at the same moment, only its voice actor records, and it stops by itself
 * when the line ends. Then the next line's voice actor starts theirs.
 */
export function useLineTakes(opts: {
  script: Script;
  video: RefObject<HTMLVideoElement | null>;
  mic: MediaStream | null;
  /** characters this player voices */
  mine: ReadonlySet<number>;
  group: GroupView | undefined;
  meId: string;
  roundId: string;
  /** false while the player is busy in the other ("Tek seferde") mode */
  enabled: boolean;
  onError: (msg: string) => void;
  onRestored?: (count: number) => void;
}) {
  const { script, video, mic, mine, group, meId, roundId, enabled, onError, onRestored } = opts;
  const storePrefix = `${roundId}:${meId}:line:`;
  const lines = script.lines;
  const chunks = useMemo(() => buildChunks(lines, mine, script.duration), [lines, script.duration, mine]);
  const chunkOf = (lineId: string) => chunks.find((c) => c.id === lineId);
  const [takes, setTakes] = useState<Record<string, Recorded>>({});
  const takesRef = useRef(takes);
  const [phase, setPhase] = useState<LinePhase>('idle');
  const [countTo, setCountTo] = useState(0);
  const handle = useRef<TakeHandle | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const raf = useRef(0);
  const stopListen = useRef<(() => void) | null>(null);
  const seen = useRef<number | undefined>(group?.lineTake?.startAt);

  const cursor = group?.lineCursor ?? 0;
  const take = group?.lineTake;
  const duration = () => script.duration || video.current?.duration || 0;
  const ownerOf = (index: number) => (lines[index] ? group?.roles[lines[index].speaker] : undefined);
  const isMine = (index: number) => !!lines[index] && mine.has(lines[index].speaker);

  const stopLocal = () => {
    window.clearTimeout(timer.current);
    cancelAnimationFrame(raf.current);
    video.current?.pause();
  };

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      cancelAnimationFrame(raf.current);
      handle.current?.abort();
      stopListen.current?.();
    },
    [],
  );

  // Takes saved in the browser come back after a refresh.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await dropOtherRounds(roundId);
      const saved = await loadTakes(storePrefix);
      const restored: Record<string, Recorded> = {};
      for (const [key, tk] of saved) {
        const lineId = key.slice(storePrefix.length);
        if (!lines.some((l) => l.id === lineId) || tk.at === undefined) continue;
        try {
          const buf = await decodeTake(tk.blob);
          restored[lineId] = { samples: monoOf(buf), sampleRate: buf.sampleRate, at: tk.at };
        } catch {
          /* unreadable: skip it */
        }
      }
      if (cancelled || !Object.keys(restored).length) return;
      const next = { ...restored, ...takesRef.current };
      takesRef.current = next;
      setTakes(next);
      onRestored?.(Object.keys(restored).length);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storePrefix]);

  // React to a line being started by its voice actor (possibly us).
  useEffect(() => {
    if (!take) {
      // the take was cancelled or expired: stop following along
      if (phase === 'countdown' || phase === 'following') {
        stopLocal();
        setPhase('idle');
      }
      return;
    }
    if (take.startAt === seen.current) return;
    seen.current = take.startAt;
    if (!enabled || take.startAt < serverNow() - 1500) return;
    const v = video.current;
    const line = lines[take.index];
    if (!v || !line) return;

    stopListen.current?.();
    stopLocal();
    const span = lineSpan(line, duration());
    v.currentTime = span.from;
    setCountTo(take.startAt);
    setPhase('countdown');
    const mineNow = take.by === meId;

    timer.current = window.setTimeout(() => {
      if (mineNow) {
        const chunk = chunkOf(line.id);
        if (!mic || !chunk) {
          onError('Mikrofonun kapalı, replik kaydedilemedi');
          act({ type: 'lineCancel' });
          setPhase('idle');
          return;
        }
        setPhase('recording');
        const h = recordTake(mic, v, { until: chunk.winEnd + 0.15 });
        handle.current = h;
        h.done
          .then(async (tk) => {
            handle.current = null;
            const buf = await decodeTake(tk.blob);
            const at = chunk.playFrom - tk.autoTrimMs / 1000;
            void saveTake(storePrefix + line.id, { blob: tk.blob, mime: tk.mime, at });
            const next = {
              ...takesRef.current,
              [line.id]: { samples: monoOf(buf), sampleRate: buf.sampleRate, at },
            };
            takesRef.current = next;
            setTakes(next);
            setPhase('idle');
            act({ type: 'lineDone', index: take.index });
          })
          .catch((e: Error) => {
            handle.current = null;
            if (e?.name !== 'AbortError') onError(`Kayıt hatası: ${e?.message ?? e}`);
            act({ type: 'lineCancel' });
            setPhase('idle');
          });
      } else {
        // someone else's line: watch it with them
        setPhase('following');
        void v.play().catch(() => {});
        const watch = () => {
          if (v.currentTime >= span.until || v.ended) {
            v.pause();
            setPhase('idle');
            return;
          }
          raf.current = requestAnimationFrame(watch);
        };
        raf.current = requestAnimationFrame(watch);
      }
    }, Math.max(0, take.startAt - serverNow()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take?.startAt, take === undefined]);

  /** Starts the current line (only works when it is ours): server sends the 3-2-1 to the group. */
  const start = () => {
    if (!isMine(cursor) || phase !== 'idle' || !mic) return;
    act({ type: 'lineStart' });
  };

  const cancel = () => {
    if (phase === 'recording' || (phase === 'countdown' && take?.by === meId)) {
      window.clearTimeout(timer.current);
      handle.current?.abort();
      if (phase === 'countdown') act({ type: 'lineCancel' });
    }
    stopLocal();
    setPhase('idle');
  };

  /** All of our takes laid onto one track as long as the clip. */
  const assemble = () => {
    const recorded = chunks.filter((c) => takesRef.current[c.id]);
    if (!recorded.length) return null;
    const sampleRate = takesRef.current[recorded[0].id].sampleRate;
    const samples = placeTakes(
      recorded.map((c) => ({ ...takesRef.current[c.id], winStart: c.winStart, winEnd: c.winEnd })),
      duration(),
      sampleRate,
    );
    return { samples, sampleRate };
  };

  /** Plays the clip with our takes over it: one line (by script index) or everything. */
  const listen = (manualMs: number, index?: number) => {
    const v = video.current;
    const a = assemble();
    if (!v || !a || phase !== 'idle') return;
    const buf = audioCtx().createBuffer(1, a.samples.length, a.sampleRate);
    buf.getChannelData(0).set(a.samples);
    const span = index === undefined ? undefined : lineSpan(lines[index], duration());
    setPhase('listening');
    stopListen.current = playPreview(v, buf, manualMs, {
      from: span?.from ?? 0,
      until: span ? span.until + 0.2 : undefined,
      onEnd: () => {
        stopListen.current = null;
        setPhase('idle');
      },
    });
  };

  /** Our takes as one small file for upload (Opus where the browser can, else a 24 kHz WAV). */
  const encode = async (): Promise<{ blob: Blob; mime: string } | null> => {
    const a = assemble();
    return a ? encodeVoice(a.samples, a.sampleRate) : null;
  };

  return {
    lines,
    cursor,
    take,
    phase,
    countTo,
    ownerOf,
    isMine,
    has: (lineId: string) => !!takes[lineId],
    myLineCount: chunks.length,
    myRecordedCount: chunks.filter((c) => takes[c.id]).length,
    start,
    go: (index: number) => act({ type: 'lineGo', index }),
    cancel,
    finish: () => handle.current?.finish(),
    listen,
    stopListening: () => stopListen.current?.(),
    encode,
  };
}
