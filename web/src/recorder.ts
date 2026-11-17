let ctx: AudioContext | null = null;

export function audioCtx(): AudioContext {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function openMic(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
}

function pickMime(): string {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return options.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

/**
 * How late the player's voice lands in the recording relative to what they
 * saw/heard: speaker output delay + microphone input delay.
 */
function latencyMs(stream: MediaStream): number {
  const c = audioCtx();
  const out = (c.outputLatency || 0) + (c.baseLatency || 0);
  const settings = stream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & { latency?: number };
  const input = typeof settings?.latency === 'number' ? settings.latency : 0;
  return Math.round((out + input) * 1000);
}

export interface Take {
  blob: Blob;
  mime: string;
  /** ms to cut from the start of the recording so it lines up with the clip */
  autoTrimMs: number;
}

export interface TakeHandle {
  done: Promise<Take>;
  /** stop now and keep what was recorded */
  finish(): void;
  /** stop now and throw the take away */
  abort(): void;
}

/** Records the mic while the clip plays from 0. `video` must already be at 0 and paused. */
export function recordTake(stream: MediaStream, video: HTMLVideoElement, opts: { until?: number } = {}): TakeHandle {
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 128_000 } : undefined);
  const chunks: Blob[] = [];
  let recStart = 0;
  let videoStart = 0;
  let aborted = false;
  let raf = 0;
  let reject: (e: unknown) => void = () => {};

  const stop = () => {
    if (rec.state !== 'inactive') rec.stop();
  };
  const onPlaying = () => {
    if (!videoStart) videoStart = performance.now();
  };
  const onEnded = () => window.setTimeout(stop, 700);
  // line-by-line takes stop by themselves at the end of the line
  const watch = () => {
    if (opts.until !== undefined && video.currentTime >= opts.until) {
      video.pause();
      window.setTimeout(stop, 150);
      return;
    }
    raf = requestAnimationFrame(watch);
  };
  video.addEventListener('playing', onPlaying);
  video.addEventListener('ended', onEnded);
  const cleanup = () => {
    cancelAnimationFrame(raf);
    video.removeEventListener('playing', onPlaying);
    video.removeEventListener('ended', onEnded);
  };

  const done = new Promise<Take>((resolve, rej) => {
    reject = rej;
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstart = () => {
      recStart = performance.now();
      video.play().then(
        () => {
          raf = requestAnimationFrame(watch);
        },
        (err) => {
          aborted = true;
          stop();
          rej(err);
        },
      );
    };
    rec.onstop = () => {
      cleanup();
      video.pause();
      if (aborted) return;
      const type = rec.mimeType || mime || 'audio/webm';
      resolve({
        blob: new Blob(chunks, { type }),
        mime: type.split(';')[0],
        autoTrimMs: Math.round((videoStart || recStart) - recStart) + latencyMs(stream),
      });
    };
    rec.onerror = (e) => {
      aborted = true;
      cleanup();
      rej(e);
    };
  });
  rec.start(500);

  return {
    done,
    finish: stop,
    abort: () => {
      aborted = true;
      stop();
      reject(new DOMException('Kayıt iptal edildi', 'AbortError'));
    },
  };
}

export function decodeTake(blob: Blob): Promise<AudioBuffer> {
  return blob.arrayBuffer().then((buf) => audioCtx().decodeAudioData(buf));
}

/**
 * Plays the clip with the recorded voice laid over it, from `from` until `until` (seconds on the
 * clip). `voice` sample 0 is clip time 0, shifted earlier by trimMs. Returns a stop function.
 */
export function playPreview(
  video: HTMLVideoElement,
  voice: AudioBuffer,
  trimMs: number,
  opts: { from?: number; until?: number; onEnd?: () => void } = {},
): () => void {
  const c = audioCtx();
  const from = opts.from ?? 0;
  const src = c.createBufferSource();
  src.buffer = voice;
  src.connect(c.destination);
  let started = false;
  let stopped = false;
  let timer: number | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(timer);
    video.removeEventListener('ended', stop);
    if (started) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    video.pause();
    opts.onEnd?.();
  };
  video.pause();
  video.currentTime = from;
  video
    .play()
    .then(() => {
      if (stopped) return;
      started = true;
      const offset = from + trimMs / 1000;
      src.start(c.currentTime + Math.max(0, -offset), Math.max(0, offset));
      if (opts.until !== undefined) timer = window.setTimeout(stop, Math.max(0, opts.until - from) * 1000);
    })
    .catch(stop);
  video.addEventListener('ended', stop);
  return stop;
}
