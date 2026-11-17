import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { GameView, Suggestion, SuggestResult } from '../../shared/types.ts';
import { send, toast } from './net.ts';
import { fmtTime, thumb } from './util.ts';

/** Host setting: the YouTube playlist that "no idea?" suggestions come from. */
export function PlaylistSetting({ g }: { g: GameView }) {
  const pl = g.playlist;
  const [url, setUrl] = useState(pl?.url ?? '');
  const [busy, setBusy] = useState(false);

  const save = async (e?: FormEvent, value = url) => {
    e?.preventDefault();
    setBusy(true);
    try {
      await send({ type: 'setPlaylist', url: value });
      if (!value) setUrl('');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="playlist-setting" onSubmit={save}>
      <span className="label">🎲 Öneri listesi (isteğe bağlı): aklına video gelmeyen buradan seçer</span>
      <div className="row">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="YouTube oynatma listesi linki (…list=…)"
          aria-label="Öneri listesi linki"
        />
        <button disabled={busy || !url.trim()}>{pl && pl.url === url.trim() ? 'Yeniden oku' : 'Kaydet'}</button>
        {pl && (
          <button type="button" className="ghost" disabled={busy} onClick={() => void save(undefined, '')}>
            Kaldır
          </button>
        )}
      </div>
      {pl && <PlaylistStatus g={g} />}
    </form>
  );
}

function PlaylistStatus({ g }: { g: GameView }) {
  const pl = g.playlist!;
  if (pl.status === 'loading' && !pl.count) {
    return (
      <p className="muted small">
        ⏳ Liste okunuyor…{!g.workerOnline && ' (stüdyo bağlanınca okunacak)'}
      </p>
    );
  }
  if (pl.status === 'error' && !pl.count) return <p className="error small">⚠️ {pl.error}</p>;
  return (
    <p className="ok-text small">
      ✔ {pl.count} video{pl.title ? ` · ${pl.title}` : ''}
      {pl.error && <span className="error"> (son okuma başarısız: {pl.error})</span>}
    </p>
  );
}

function durationLabel(s: Suggestion): string | null {
  return s.duration ? fmtTime(s.duration).replace(/\.\d$/, '') : null;
}

/**
 * Two videos from the host's playlist; clicking one fills the submit form, the dice button
 * brings two others. Shows nothing for players when no playlist is set.
 */
export function Suggestions({
  g,
  selectedId,
  onPick,
}: {
  g: GameView;
  selectedId: string | null;
  onPick: (s: Suggestion) => void;
}) {
  const pl = g.playlist;
  const [items, setItems] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const shown = useRef<string[]>([]);
  const ready = !!pl?.count;

  const roll = useCallback(async () => {
    setBusy(true);
    try {
      const res = (await send({ type: 'suggest', exclude: shown.current })) as SuggestResult;
      setItems(res.items);
      shown.current = [...shown.current, ...res.items.map((x) => x.youtubeId)].slice(-200);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (ready) void roll();
    else setItems([]);
  }, [ready, roll]);

  if (!pl) {
    if (!g.me?.isHost) return null;
    return (
      <details className="suggest-box">
        <summary>🎲 Aklına video gelmeyenler için öneri listesi ekle</summary>
        <PlaylistSetting g={g} />
      </details>
    );
  }

  return (
    <div className="suggest-box">
      <div className="suggest-head">
        <b>🎲 Aklına video gelmedi mi? Birini seç:</b>
        {ready && (
          <button className="small" disabled={busy} onClick={() => void roll()} title="Başka iki video getir">
            🔄 Başka iki tane
          </button>
        )}
      </div>
      {!ready && <PlaylistStatus g={g} />}
      {ready && (
        <div className="suggest-grid">
          {items.map((s) => {
            const d = durationLabel(s);
            return (
              <button
                key={s.youtubeId}
                type="button"
                className={`suggest-card ${selectedId === s.youtubeId ? 'on' : ''}`}
                onClick={() => onPick(s)}
                title={s.title}
              >
                <span className="suggest-thumb">
                  <img src={thumb(s.youtubeId)} alt="" loading="lazy" />
                  {d && <span className="suggest-dur">{d}</span>}
                </span>
                <span className="suggest-title">{s.title}</span>
              </button>
            );
          })}
        </div>
      )}
      {g.me?.isHost && (
        <details className="suggest-admin">
          <summary>Listeyi değiştir</summary>
          <PlaylistSetting g={g} />
        </details>
      )}
    </div>
  );
}
