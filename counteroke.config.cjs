// pm2 configuration for running counteroke on the phone (Termux).
//
//   pm2 start counteroke.config.cjs     <- game night: server + worker + tunnel
//   pm2 delete counteroke.config.cjs    <- done: removes all three, anucvc keeps running
//   pm2 logs counteroke-tunnel          <- shows the https://....trycloudflare.com link
//
// Secrets live in counteroke.secrets.json next to this file (not in git):
//   cp counteroke.secrets.example.json counteroke.secrets.json   then edit it.
// The worker runs inside the proot-distro Ubuntu box; see docs/telefon-kurulum.md.

const fs = require('node:fs');
const path = require('node:path');

let secrets = {};
try {
  secrets = JSON.parse(fs.readFileSync(path.join(__dirname, 'counteroke.secrets.json'), 'utf8'));
} catch {
  console.warn('counteroke.secrets.json bulunamadı: varsayılan (güvensiz) anahtar kullanılıyor.');
}
const WORKER_TOKEN = secrets.WORKER_TOKEN || 'counteroke-dev';
const GAME_PASSWORD = secrets.GAME_PASSWORD || ''; // empty = no password
const PORT = 3100;
const PROJECT = __dirname;

module.exports = {
  apps: [
    {
      name: 'counteroke-server',
      cwd: PROJECT,
      script: 'server/start.js',
      interpreter: 'node',
      autorestart: true,
      // KEEP_DAYS: clips and scene videos unused this many days are deleted (0 = keep forever)
      env: { PORT, WORKER_TOKEN, GAME_PASSWORD, MAX_CLIP_SECONDS: 120, KEEP_DAYS: 7 },
    },
    {
      name: 'counteroke-worker',
      cwd: PROJECT,
      script: 'proot-distro',
      args: [
        'login', 'ubuntu', '--bind', `${PROJECT}:/counteroke`, '--',
        'env', 'PATH=/root/.deno/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        `WORKER_TOKEN=${WORKER_TOKEN}`, 'WORKER_THREADS=4', 'WORKER_NAME=telefon',
        'nice', '-n', '10',
        '/counteroke/worker/.venv-phone/bin/python', '-u', '/counteroke/worker/worker.py',
        '--server', `http://127.0.0.1:${PORT}`, '--slow',
      ],
      interpreter: 'none',
      autorestart: true,
    },
    {
      name: 'counteroke-tunnel',
      script: 'cloudflared',
      args: ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`],
      interpreter: 'none',
      autorestart: true,
    },
  ],
};
