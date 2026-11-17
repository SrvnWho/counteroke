// Turns an assembled voice track into a small file for upload. Browsers with WebCodecs encode it
// as Ogg Opus (about 8 KB per second); others send a 24 kHz WAV (48 KB per second) instead of the
// 96 KB per second a full-rate WAV would take.
import { encodeWav } from './takes.ts';

const OPUS_RATE = 48000;
const OPUS_BITRATE = 64000;
/** libopus' usual encoder delay at 48 kHz, used when the encoder doesn't report its own. */
const DEFAULT_PRE_SKIP = 312;

/** Resamples mono samples with the browser's own resampler. */
export async function resample(samples: Float32Array, from: number, to: number): Promise<Float32Array> {
  if (from === to) return samples;
  const length = Math.max(1, Math.ceil((samples.length * to) / from));
  const ctx = new OfflineAudioContext(1, length, to);
  const buf = ctx.createBuffer(1, samples.length, from);
  buf.getChannelData(0).set(samples);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

// ------------------------------------------------------------------ Ogg container

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ data[i]) & 0xff]) >>> 0;
  return crc;
}

const FLAG_FIRST = 0x02;
const FLAG_LAST = 0x04;

/** One Ogg page holding whole packets. */
export function oggPage(packets: Uint8Array[], granule: number, serial: number, seq: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  if (lacing.length > 255) throw new Error('Ogg sayfası çok büyük');
  const body = packets.reduce((a, p) => a + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + body);
  const v = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  page[5] = flags;
  v.setUint32(6, granule >>> 0, true); // 64-bit granule position, low half
  v.setUint32(10, Math.floor(granule / 2 ** 32), true);
  v.setUint32(14, serial, true);
  v.setUint32(18, seq, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) {
    page.set(p, o);
    o += p.length;
  }
  v.setUint32(22, crc32(page), true);
  return page;
}

function opusHead(preSkip: number, inputRate: number): Uint8Array {
  const b = new Uint8Array(19);
  const v = new DataView(b.buffer);
  b.set(new TextEncoder().encode('OpusHead'));
  b[8] = 1; // version
  b[9] = 1; // mono
  v.setUint16(10, preSkip, true);
  v.setUint32(12, inputRate, true);
  return b; // output gain 0, channel mapping 0
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode('counteroke');
  const b = new Uint8Array(8 + 4 + vendor.length + 4);
  const v = new DataView(b.buffer);
  b.set(new TextEncoder().encode('OpusTags'));
  v.setUint32(8, vendor.length, true);
  b.set(vendor, 12);
  return b; // no user comments
}

export interface OpusPacket {
  data: Uint8Array;
  /** samples at 48 kHz */
  samples: number;
}

/** Packs Opus packets into an Ogg Opus file whose length is exactly `length` samples at 48 kHz. */
export function muxOggOpus(packets: OpusPacket[], length: number, preSkip: number, inputRate: number): Blob {
  const serial = (Math.random() * 2 ** 32) >>> 0;
  const pages: Uint8Array[] = [
    oggPage([opusHead(preSkip, inputRate)], 0, serial, 0, FLAG_FIRST),
    oggPage([opusTags()], 0, serial, 1, 0),
  ];
  const end = preSkip + length; // the decoder drops pre-skip at the start and anything past `end`
  let done = 0;
  let batch: Uint8Array[] = [];
  let segments = 0;
  const flush = (last: boolean) => {
    pages.push(oggPage(batch, Math.min(end, preSkip + done), serial, pages.length, last ? FLAG_LAST : 0));
    batch = [];
    segments = 0;
  };
  packets.forEach((p, i) => {
    const need = Math.floor(p.data.length / 255) + 1;
    if (segments + need > 255 || batch.length >= 50) flush(false);
    batch.push(p.data);
    segments += need;
    done += p.samples;
    if (i === packets.length - 1) flush(true);
  });
  if (!packets.length) flush(true);
  return new Blob(pages as BlobPart[], { type: 'audio/ogg' });
}

// ------------------------------------------------------------------ encoding

async function encodeOggOpus(samples: Float32Array, sampleRate: number): Promise<Blob> {
  const config: AudioEncoderConfig = { codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 1, bitrate: OPUS_BITRATE };
  if (!(await AudioEncoder.isConfigSupported(config)).supported) throw new Error('Opus desteklenmiyor');
  const pcm = await resample(samples, sampleRate, OPUS_RATE);
  const packets: OpusPacket[] = [];
  let head: Uint8Array | undefined;
  let failure: unknown;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({ data, samples: Math.round(((chunk.duration ?? 20_000) * OPUS_RATE) / 1e6) });
      const desc = meta?.decoderConfig?.description;
      if (desc && !head) {
        head = ArrayBuffer.isView(desc)
          ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength).slice()
          : new Uint8Array(desc as ArrayBuffer).slice();
      }
    },
    error: (e) => {
      failure = e;
    },
  });
  encoder.configure(config);
  const step = OPUS_RATE / 10; // 100 ms per AudioData
  for (let i = 0; i < pcm.length; i += step) {
    const part = pcm.slice(i, Math.min(pcm.length, i + step));
    const frame = new AudioData({
      format: 'f32',
      sampleRate: OPUS_RATE,
      numberOfFrames: part.length,
      numberOfChannels: 1,
      timestamp: Math.round((i / OPUS_RATE) * 1e6),
      data: part,
    });
    encoder.encode(frame);
    frame.close();
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  const isHead = head && head.length >= 12 && new TextDecoder().decode(head.slice(0, 8)) === 'OpusHead';
  const preSkip = isHead ? head![10] | (head![11] << 8) : DEFAULT_PRE_SKIP;
  return muxOggOpus(packets, pcm.length, preSkip, sampleRate);
}

/** The smallest file this browser can make for a mono voice track. */
export async function encodeVoice(samples: Float32Array, sampleRate: number): Promise<{ blob: Blob; mime: string }> {
  if (typeof AudioEncoder !== 'undefined') {
    try {
      return { blob: await encodeOggOpus(samples, sampleRate), mime: 'audio/ogg' };
    } catch (e) {
      console.warn('Opus kodlanamadı, WAV gönderilecek', e);
    }
  }
  const rate = Math.min(sampleRate, 24000);
  const down = await resample(samples, sampleRate, rate);
  return { blob: new Blob([encodeWav(down, rate)], { type: 'audio/wav' }), mime: 'audio/wav' };
}
