import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { EffectId } from '../../shared/constants.ts';
import { config } from './config.ts';

const SR = 48000;

/** ffmpeg audio filter for each voice effect. All of them keep the clip's length. */
export function effectFilter(effect: EffectId): string {
  const pitch = (factor: number) => `asetrate=${Math.round(SR * factor)},aresample=${SR},atempo=${(1 / factor).toFixed(4)}`;
  switch (effect) {
    case 'kalin':
      return pitch(0.8);
    case 'ince':
      return pitch(1.35);
    case 'canavar':
      return pitch(0.65);
    case 'yasli':
      return `${pitch(0.9)},vibrato=f=5:d=0.35`;
    case 'robot':
      return "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75";
    case 'radyo':
      return 'highpass=f=300,lowpass=f=3400,acompressor=threshold=0.08:ratio=6:makeup=3';
    case 'yanki':
      return 'aecho=0.8:0.85:70|140:0.35|0.2';
    default:
      return 'anull';
  }
}

export interface TrackPart {
  characterId: number;
  effect: EffectId;
  /** [start, end] seconds of this character's lines on the clip timeline */
  segments: [number, number][];
}

export interface Track {
  file: string;
  /** ms to cut from the start of the recording so it lines up with the clip (negative = pad) */
  trimMs: number;
  /** the player's characters; the first one also gets any speech outside all of their lines */
  parts: TrackPart[];
}

const PAD = 0.35;

function insideExpr(segments: [number, number][]): string {
  return segments
    .map(([s, e]) => `between(t,${Math.max(0, s - PAD).toFixed(2)},${(e + PAD).toFixed(2)})`)
    .join('+');
}

/** Builds the -filter_complex graph: clip music/effects + every voice track. Exported for tests. */
export function buildFilterGraph(tracks: Track[]): { graph: string; voiceCount: number } {
  const chains: string[] = [`[0:a]aresample=${SR},aformat=channel_layouts=stereo[bg]`];
  const voiceLabels: string[] = [];

  tracks.forEach((track, i) => {
    const input = i + 1;
    const align =
      track.trimMs >= 0
        ? `atrim=start=${(track.trimMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS`
        : `adelay=${Math.round(-track.trimMs)}`;
    const clean = `aresample=${SR},aformat=channel_layouts=mono,${align},highpass=f=80,acompressor=threshold=0.125:ratio=3:makeup=2`;

    if (track.parts.length <= 1) {
      const effect = effectFilter(track.parts[0]?.effect ?? 'normal');
      chains.push(`[${input}:a]${clean},${effect},aformat=channel_layouts=stereo[v${i}]`);
      voiceLabels.push(`[v${i}]`);
      return;
    }

    // One player, several characters: split the take and gate each copy to that
    // character's lines before applying its effect.
    const branches = track.parts.map((_, j) => `[t${i}_${j}]`);
    chains.push(`[${input}:a]${clean},asplit=${track.parts.length}${branches.join('')}`);
    track.parts.forEach((part, j) => {
      let gate: string;
      if (j === 0) {
        const others = track.parts.slice(1).flatMap((p) => p.segments);
        gate = others.length ? `volume=0:enable='${insideExpr(others)}'` : 'anull';
      } else {
        gate = part.segments.length ? `volume=0:enable='not(${insideExpr(part.segments)})'` : 'volume=0';
      }
      chains.push(`${branches[j]}${gate},${effectFilter(part.effect)},aformat=channel_layouts=stereo[v${i}_${j}]`);
      voiceLabels.push(`[v${i}_${j}]`);
    });
  });

  const inputs = 1 + voiceLabels.length;
  chains.push(
    `[bg]${voiceLabels.join('')}amix=inputs=${inputs}:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]`,
  );
  return { graph: chains.join(';'), voiceCount: voiceLabels.length };
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg çıkış kodu ${code}: ${stderr.trim().split('\n').slice(-4).join(' | ')}`));
    });
  });
}

/**
 * Renders the group's final video (original picture, music/effects and all voices) and, when asked,
 * the same sound as a separate audio file. The picture is copied, never re-encoded.
 */
export async function mixGroup(clipFile: string, out: { video: string; audio?: string }, tracks: Track[]): Promise<void> {
  fs.mkdirSync(path.dirname(out.video), { recursive: true });
  const tmpVideo = `${out.video}.tmp.mp4`;
  const tmpAudio = out.audio ? `${out.audio}.tmp.m4a` : undefined;
  let { graph } = buildFilterGraph(tracks);
  if (tmpAudio) graph += ';[aout]asplit=2[aoutv][aouta]';
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', clipFile];
  for (const t of tracks) args.push('-i', t.file);
  args.push(
    '-filter_complex', graph,
    '-map', '0:v:0', '-map', tmpAudio ? '[aoutv]' : '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    tmpVideo,
  );
  if (tmpAudio) args.push('-map', '[aouta]', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmpAudio);
  await run(config.ffmpeg, args);
  fs.renameSync(tmpVideo, out.video);
  if (tmpAudio && out.audio) fs.renameSync(tmpAudio, out.audio);
}
