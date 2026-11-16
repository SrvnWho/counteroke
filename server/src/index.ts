import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';
import type { Ack, Action, JoinResult, Script } from '../../shared/types.ts';
import { cleanup } from './cleanup.ts';
import { config } from './config.ts';
import { Game, GameError } from './game.ts';

for (const dir of [config.dataDir, config.clipsDir, config.recordingsDir, config.mixesDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

let broadcastQueued = false;
const game = new Game(() => {
  if (broadcastQueued) return;
  broadcastQueued = true;
  setTimeout(() => {
    broadcastQueued = false;
    for (const socket of io.of('/').sockets.values()) socket.emit('state', game.view(socket.data.playerId ?? null));
  }, 25);
});

function errorMessage(e: unknown): string {
  if (e instanceof GameError) return e.message;
  console.error(e);
  return 'Sunucuda bir hata oldu';
}

function attach(socket: Socket, playerId: string): void {
  if (socket.data.playerId === playerId) return;
  if (socket.data.playerId) game.disconnect(socket.data.playerId);
  socket.data.playerId = playerId;
  game.connect(playerId);
  socket.emit('state', game.view(playerId));
}

io.on('connection', (socket) => {
  socket.emit('state', game.view(null));

  socket.on('time', (ack: unknown) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('hello', (p: { playerId?: string; secret?: string }, ack: (a: Ack) => void) => {
    if (game.auth(p?.playerId, p?.secret)) {
      attach(socket, p.playerId!);
      ack?.({ ok: true });
    } else ack?.({ ok: false, error: 'Oturum bulunamadı' });
  });

  socket.on('join', (p: { name?: string; password?: string }, ack: (a: Ack<JoinResult>) => void) => {
    try {
      const result = game.join(p?.name, p?.password);
      attach(socket, result.playerId);
      ack?.({ ok: true, data: result });
    } catch (e) {
      ack?.({ ok: false, error: errorMessage(e) });
    }
  });

  socket.on('action', (action: Action, ack: (a: Ack) => void) => {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) return ack?.({ ok: false, error: 'Önce oyuna katıl' });
    try {
      const data = game.handle(playerId, action);
      ack?.({ ok: true, data });
    } catch (e) {
      ack?.({ ok: false, error: errorMessage(e) });
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.playerId) game.disconnect(socket.data.playerId);
  });
});

// ------------------------------------------------------------------ uploads

async function saveBody(req: Request, file: string, maxBytes: number): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) cb(new GameError('Dosya çok büyük'));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limit, fs.createWriteStream(file));
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
}

const AUDIO_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/webm': 'webm',
};

app.put('/api/recording', async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const player = req.get('x-player') ?? '';
  const secret = req.get('x-secret') ?? '';
  const type = String(req.get('content-type') ?? '').split(';')[0].trim();
  const ext = AUDIO_EXT[type] ?? 'bin';
  const tmp = path.join(config.recordingsDir, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  try {
    if (!game.auth(player, secret)) throw new GameError('Yetkisiz');
    await saveBody(req, tmp, 40 * 1024 * 1024);
    game.saveRecording(player, secret, String(q.round), Number(q.trimMs), ext, tmp);
    res.json({ ok: true });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    res.status(400).json({ ok: false, error: errorMessage(e) });
  }
});

// A take rendered with the player's effects, only for them to listen to before sending.
app.put('/api/preview', async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const player = req.get('x-player') ?? '';
  const secret = req.get('x-secret') ?? '';
  const type = String(req.get('content-type') ?? '').split(';')[0].trim();
  const ext = AUDIO_EXT[type] ?? 'bin';
  const tmp = path.join(config.recordingsDir, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  try {
    if (!game.auth(player, secret)) throw new GameError('Yetkisiz');
    await saveBody(req, tmp, 40 * 1024 * 1024);
    const url = await game.renderPreview(player, secret, String(q.round), Number(q.trimMs), ext, tmp);
    res.json({ ok: true, data: { url } });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    res.status(400).json({ ok: false, error: errorMessage(e) });
  }
});

// ------------------------------------------------------------------ worker API

function workerAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.get('x-worker-token') === config.workerToken) next();
  else res.status(401).json({ ok: false, error: 'Geçersiz worker anahtarı' });
}

function wrap(fn: (req: Request, res: Response) => unknown | Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json({ ok: true, data: out ?? null });
    } catch (e) {
      if (!res.headersSent) res.status(400).json({ ok: false, error: errorMessage(e) });
    }
  };
}

app.get('/api/worker/next', workerAuth, (req, res) => {
  const job = game.nextJob(String(req.query.name ?? 'worker').slice(0, 40), req.query.fast === '1');
  if (job) res.json(job);
  else res.status(204).end();
});

app.post('/api/worker/jobs/:id/progress', workerAuth, express.json(), wrap((req) => {
  game.jobProgress(String(req.params.id), req.body?.stage, req.body?.progress);
}));

app.put('/api/worker/jobs/:id/clip', workerAuth, wrap(async (req) => {
  await saveBody(req, game.jobUploadPath(String(req.params.id)), 500 * 1024 * 1024);
}));

app.post('/api/worker/jobs/:id/done', workerAuth, express.json({ limit: '5mb' }), wrap((req) => {
  game.jobDone(String(req.params.id), req.body?.script as Script);
}));

app.post('/api/worker/jobs/:id/fail', workerAuth, express.json(), wrap((req) => {
  game.jobFail(String(req.params.id), req.body?.error);
}));

// ------------------------------------------------------------------ media + web

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/media/clips', express.static(config.clipsDir, { maxAge: '1h', index: false }));
app.use(
  '/media/mixes',
  (req, res, next) => {
    // ?download=name.mp4 makes the browser save the file under a readable name
    const name = typeof req.query.download === 'string' ? req.query.download.replace(/[^\w.-]/g, '_').slice(0, 80) : '';
    if (name) res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    next();
  },
  express.static(config.mixesDir, { index: false }),
);

if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
  app.use(express.static(config.webDist, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || /^\/(api|media|socket\.io)\//.test(req.path)) return next();
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.type('text').send('Arayüz derlenmemiş. Proje klasöründe `npm run build` çalıştır.');
  });
}

// ------------------------------------------------------------------ storage cleanup

function runCleanup(): void {
  const keep = game.inUse();
  const res = cleanup({
    clipsDir: config.clipsDir,
    mixesDir: config.mixesDir,
    recordingsDir: config.recordingsDir,
    keepDays: config.keepDays,
    keepClipKeys: keep.clipKeys,
    keepRoundIds: keep.roundIds,
  });
  if (res.clips || res.rounds || res.leftovers) {
    console.log(
      `Temizlik: ${res.clips} eski klip, ${res.rounds} eski sahnenin videoları, ${res.leftovers} artık dosya silindi ` +
        `(${(res.bytes / 1e6).toFixed(1)} MB).`,
    );
  }
}
runCleanup();
setInterval(runCleanup, 6 * 3600_000).unref();

server.listen(config.port, config.host, () => {
  console.log(`counteroke sunucusu: http://localhost:${config.port}`);
  if (config.workerToken === 'counteroke-dev') {
    console.log('Uyarı: WORKER_TOKEN ayarlanmamış, varsayılan anahtar kullanılıyor.');
  }
});
