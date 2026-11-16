import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { GameView, GroupView } from '../../../shared/types.ts';
import { act, serverNow } from '../net.ts';
import { charColor, groupLabel, mixDownload, useNow } from '../util.ts';
import { Avatar, Countdown, PlayerTag } from '../ui.tsx';

/** Starts the video at the same server moment for everyone. */
function SyncedVideo({ src, startAt, onEnded }: { src?: string; startAt?: number; onEnded: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);
  const now = useNow(250);

  const go = useCallback(() => {
    const v = ref.current;
    if (!v || !startAt) return;
    const late = (serverNow() - startAt) / 1000;
    if (late > 0.3 && (!v.duration || late < v.duration)) v.currentTime = late;
    v.play().then(
      () => setBlocked(false),
      () => setBlocked(true),
    );
  }, [startAt]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !src || !startAt) return;
    v.pause();
    v.currentTime = 0;
    const timer = window.setTimeout(go, Math.max(0, startAt - serverNow()));
    return () => window.clearTimeout(timer);
  }, [src, startAt, go]);

  const wait = startAt ? (startAt - (now + (serverNow() - Date.now()))) / 1000 : 0;
  return (
    <div className="marquee">
      <div className="video-wrap">
        <video ref={ref} src={src} playsInline controls className="clip big-clip" onEnded={onEnded} />
        {wait > 0 && (
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
      <SyncedVideo src={group.mixUrl} startAt={r.screeningStartAt} onEnded={() => setEnded(true)} />
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
