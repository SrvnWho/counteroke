import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { GameView, GroupView } from '../../../shared/types.ts';
import { act, serverNow } from '../net.ts';
import { charColor, groupLabel, mixDownload, storedNumber, storeNumber, useNow } from '../util.ts';
import { Avatar, Countdown, PlayerTag } from '../ui.tsx';

const VOLUME_KEY = 'counteroke.galaVolume';

/**
 * The gala player. The clip's picture is already in the browser from the recording screen, so it
 * plays muted with the group's sound as a small separate file. Everyone reports when both have
 * loaded, the server then sets one start time, and a player who falls behind (buffering) is pulled
 * back in sync. Mixes without a sound file fall back to the full video.
 */
function GalaPlayer({ g, group, onEnded }: { g: GameView; group: GroupView; onEnded: () => void }) {
  const r = g.round!;
  const [audioFailed, setAudioFailed] = useState(false);
  const split = !!group.mixAudioUrl && !!r.clip?.videoUrl && !audioFailed;
  const videoSrc = split ? r.clip!.videoUrl : group.mixUrl;
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const reported = useRef(0);
  const [blocked, setBlocked] = useState(false);
  const [volume, setVolume] = useState(() => storedNumber(VOLUME_KEY, 1));
  const startAt = r.screeningStartAt;
  const seq = r.screenSeq;
  const now = useNow(250);
  const master = () => (split ? audio.current : video.current);

  // tell the server once our player can play this group's film
  useEffect(() => {
    if (startAt) return;
    const id = window.setInterval(() => {
      const m = master();
      const v = video.current;
      if (!m || !v || reported.current === seq) return;
      if (m.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        reported.current = seq;
        act({ type: 'screenReady', seq });
      }
    }, 250);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, startAt, split]);

  const go = useCallback(() => {
    const m = master();
    const v = video.current;
    if (!m || !v || !startAt) return;
    const late = (serverNow() - startAt) / 1000;
    if (late > 0.3 && (!m.duration || late < m.duration)) {
      m.currentTime = late;
      if (split) v.currentTime = late;
    }
    const plays = split ? [m.play(), v.play()] : [m.play()];
    Promise.all(plays).then(
      () => setBlocked(false),
      () => setBlocked(true),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startAt, split]);

  // start together at the server's moment
  useEffect(() => {
    const m = master();
    const v = video.current;
    if (!m || !v) return;
    m.pause();
    v.pause();
    m.currentTime = 0;
    v.currentTime = 0;
    if (!startAt) return;
    const timer = window.setTimeout(go, Math.max(0, startAt - serverNow()));
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startAt, seq, split, go]);

  // stay on the shared clock; the picture follows the sound
  useEffect(() => {
    if (!startAt) return;
    const id = window.setInterval(() => {
      const m = master();
      const v = video.current;
      if (!m || !v || m.paused || m.ended) return;
      const expected = (serverNow() - startAt) / 1000;
      if (expected > 0 && (!m.duration || expected < m.duration - 0.5) && Math.abs(m.currentTime - expected) > 0.4) {
        m.currentTime = expected;
      }
      if (split) {
        if (Math.abs(v.currentTime - m.currentTime) > 0.15) v.currentTime = m.currentTime;
        if (v.paused && !v.ended) void v.play().catch(() => {});
      }
    }, 500);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startAt, split]);

  useEffect(() => {
    const m = master();
    if (m) m.volume = volume;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, split]);

  const wait = startAt ? (startAt - (now + (serverNow() - Date.now()))) / 1000 : null;
  const connected = g.players.filter((p) => p.connected).length;
  return (
    <div className="marquee">
      <div className="video-wrap" ref={box}>
        <video
          ref={video}
          src={videoSrc}
          muted={split}
          playsInline
          preload="auto"
          className="clip big-clip"
          onEnded={split ? undefined : onEnded}
        />
        {split && (
          <audio ref={audio} src={group.mixAudioUrl} preload="auto" onEnded={onEnded} onError={() => setAudioFailed(true)} />
        )}
        {wait === null && (
          <div className="overlay dim">
            <div className="gala-wait">
              <div className="reel" />
              Herkesin videosu yükleniyor… ({Math.min(r.screenReadyCount, connected)}/{connected})
            </div>
          </div>
        )}
        {wait !== null && wait > 0 && (
          <div className="overlay dim">
            <Countdown seconds={wait} />
          </div>
        )}
        {blocked && (
          <button className="primary play-btn" onClick={go}>
            ▶ Oynat
          </button>
        )}
      </div>
      <div className="gala-controls">
        <label className="volume">
          🔊
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            aria-label="Ses düzeyi"
            onChange={(e) => {
              const v = Number(e.target.value);
              setVolume(v);
              storeNumber(VOLUME_KEY, v);
            }}
          />
        </label>
        <button className="ghost small" onClick={() => void box.current?.requestFullscreen?.()}>
          ⛶ Tam ekran
        </button>
      </div>
    </div>
  );
}

export function Stars({ value, onChange }: { value?: number; onChange: (n: number) => void }) {
  return (
    <div className="stars">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} className={value && n <= value ? 'on' : ''} onClick={() => onChange(n)} aria-label={`${n} yıldız`}>
          ★
        </button>
      ))}
    </div>
  );
}

export function DownloadLink({ roundNumber, group, big = false }: { roundNumber: number; group: GroupView; big?: boolean }) {
  const dl = mixDownload(roundNumber, group);
  if (!dl) return null;
  return (
    <a className={`btn ${big ? 'mint' : 'ghost small'}`} href={dl.href} download={dl.name}>
      ⬇ İndir
    </a>
  );
}

export function Cast({ g, group }: { g: GameView; group: GroupView }) {
  const script = g.round!.script!;
  return (
    <div className="cast">
      {script.characters.map((c) => {
        const p = g.players.find((x) => x.id === group.roles[c.id]);
        return (
          <span key={c.id} className="role" style={{ '--c': charColor(c.id) } as CSSProperties}>
            <b>{c.name}</b> 🎙️ <Avatar g={g} p={p} size={22} /> {p?.name ?? '—'}
          </span>
        );
      })}
    </div>
  );
}

export function Screening({ g }: { g: GameView }) {
  const r = g.round!;
  const groupId = r.screeningOrder[r.screeningIndex];
  const group = r.groups.find((x) => x.id === groupId);
  const [ended, setEnded] = useState(false);
  useEffect(() => setEnded(false), [groupId, r.screeningStartAt]);
  if (!group) return null;
  const last = r.screeningIndex >= r.screeningOrder.length - 1;
  // the next group's sound loads while this one is being rated
  const next = r.groups.find((x) => x.id === r.screeningOrder[r.screeningIndex + 1]);
  const raters = r.ratedBy[groupId]?.length ?? 0;
  const connected = g.players.filter((p) => p.connected).length;
  return (
    <div className="screening">
      <div className="section-head">
        <h2 className="tape pink">Gala · {groupLabel(group)}</h2>
        <span className="bubble">
          {r.screeningIndex + 1}/{r.screeningOrder.length}
        </span>
        <div className="members">
          {group.members.map((m) => (
            <PlayerTag key={m} g={g} id={m} />
          ))}
        </div>
      </div>
      <GalaPlayer key={group.id} g={g} group={group} onEnded={() => setEnded(true)} />
      {next?.mixAudioUrl && <audio src={next.mixAudioUrl} preload="auto" hidden />}
      <div className="row">
        <Cast g={g} group={group} />
        <span style={{ marginLeft: 'auto' }}>
          <DownloadLink roundNumber={r.number} group={group} big />
        </span>
      </div>
      <div className={`card rate ${ended ? 'pulse' : ''}`}>
        <span className="rate-q">Kaç yıldız?</span>
        <Stars value={r.myRatings[groupId]} onChange={(n) => act({ type: 'rate', groupId, stars: n })} />
        <span className="muted small">
          {raters}/{connected} kişi puan verdi · puanlar en sonda açıklanacak
        </span>
      </div>
      {g.me?.isHost && (
        <div className="row center">
          <button onClick={() => act({ type: 'replayScreening' })}>↺ Tekrar oynat</button>
          {last ? (
            <button className="primary" onClick={() => act({ type: 'showResults' })}>
              Sonuçları göster
            </button>
          ) : (
            <button className="primary" onClick={() => act({ type: 'nextScreening' })}>
              Sonraki grup →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
