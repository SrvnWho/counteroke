// Line-by-line recording: which parts of the clip a player records, and how the separate
// takes are put back together into one voice track on the clip's timeline. No DOM here.
import type { ScriptLine } from '../../shared/types.ts';

/** Seconds of video played before your line so you catch the rhythm. */
export const LEAD = 1.5;
/** Seconds kept before / after the line when the take is placed into the final track. */
export const PRE = 0.35;
export const POST = 0.6;

/** Where the video plays for a line, for everyone in the group: from LEAD before it until just after. */
export function lineSpan(line: ScriptLine, duration: number): { from: number; until: number } {
  const limit = duration > 0 ? duration : Infinity;
  return { from: Math.max(0, line.start - LEAD), until: Math.min(limit, line.end + POST) };
}

export interface Chunk {
  id: string;
  index: number;
  lines: ScriptLine[];
  start: number;
  end: number;
  /** where the video starts playing for this take */
  playFrom: number;
  /** the part of the take that ends up in the final track */
  winStart: number;
  winEnd: number;
}

/** Every line you voice is its own take, in script order. */
export function buildChunks(lines: readonly ScriptLine[], mine: ReadonlySet<number>, duration: number): Chunk[] {
  const groups = [...lines].sort((a, b) => a.start - b.start).filter((l) => mine.has(l.speaker)).map((l) => [l]);

  const limit = duration > 0 ? duration : Infinity;
  const chunks = groups.map((ls, index) => {
    const start = ls[0].start;
    const end = Math.max(...ls.map((x) => x.end));
    return {
      id: ls[0].id,
      index,
      lines: ls,
      start,
      end,
      playFrom: Math.max(0, start - LEAD),
      winStart: Math.max(0, start - PRE),
      winEnd: Math.min(limit, end + POST),
    };
  });
  // neighbouring takes must not overlap in the final track: split the gap between them
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const c = chunks[i];
    if (prev.winEnd > c.winStart) {
      const mid = (prev.end + c.start) / 2;
      prev.winEnd = Math.max(prev.end, mid);
      c.winStart = Math.min(c.start, mid);
    }
  }
  return chunks;
}

export interface PlacedTake {
  samples: Float32Array;
  sampleRate: number;
  /** clip time (s) of the take's first sample */
  at: number;
  winStart: number;
  winEnd: number;
}

/** Lays every take onto one silent track as long as the clip, with short fades at the cuts. */
export function placeTakes(takes: readonly PlacedTake[], duration: number, sampleRate: number): Float32Array {
  const out = new Float32Array(Math.max(1, Math.ceil(duration * sampleRate)));
  const fade = Math.max(1, Math.round(0.015 * sampleRate));
  for (const tk of takes) {
    const a = Math.max(0, Math.floor(tk.winStart * sampleRate));
    const b = Math.min(out.length, Math.ceil(tk.winEnd * sampleRate));
    const shift = Math.round(tk.at * sampleRate);
    for (let i = a; i < b; i++) {
      const j = i - shift;
      if (j < 0 || j >= tk.samples.length) continue;
      const edge = Math.min(i - a, b - 1 - i);
      out[i] += tk.samples[j] * (edge < fade ? edge / fade : 1);
    }
  }
  return out;
}

/** Mono 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const text = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** Average of all channels. */
export function monoOf(buffer: { numberOfChannels: number; length: number; getChannelData(c: number): Float32Array }): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i] / buffer.numberOfChannels;
  }
  return out;
}
