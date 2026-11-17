import { useEffect, useRef, useState } from 'react';
import { MAX_SPEAKERS } from '../../../shared/constants.ts';
import type { GameView, Lang, SubmissionView, Suggestion } from '../../../shared/types.ts';
import { parseYouTubeId, watchUrl } from '../../../shared/youtube.ts';
import { act, send, toast } from '../net.ts';
import { Suggestions } from '../Suggestions.tsx';
import { fmtTime, playerName, thumb } from '../util.ts';
import { loadYouTubeApi } from '../youtube.ts';
import type { YTPlayer } from '../youtube.ts';

function YouTubePicker({ videoId, onPlayer }: { videoId: string; onPlayer: (p: YTPlayer | null) => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let player: YTPlayer | null = null;
    let cancelled = false;
    const el = document.createElement('div');
    host.current?.appendChild(el);
    void loadYouTubeApi().then((YT) => {
      if (cancelled) return;
      player = new YT.Player(el, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: { rel: 0, playsinline: 1, modestbranding: 1 },
        events: { onReady: () => !cancelled && onPlayer(player) },
      });
    });
    return () => {
      cancelled = true;
      onPlayer(null);
      player?.destroy();
      el.remove();
    };
  }, [videoId, onPlayer]);
  return <div className="yt-frame" ref={host} />;
}

function SubmissionCard({ g, s }: { g: GameView; s: SubmissionView }) {
  const mine = s.playerId === g.me?.id;
  return (
    <div className={`sub-card ${mine ? 'mine' : ''}`}>
      <img src={thumb(s.youtubeId)} alt="" />
      <div>
        <div className="title">{s.title}</div>
        <div className="muted small">
          {playerName(g, s.playerId)} · {fmtTime(s.start)}–{fmtTime(s.end)} · {s.speakers} kişi · {s.lang.toUpperCase()}
        </div>
      </div>
      {(mine || g.me?.isHost) && (
        <button className="ghost small" onClick={() => act({ type: 'removeSubmission', submissionId: s.id })}>
          Kaldır
        </button>
      )}
    </div>
  );
}

export function Submit({ g }: { g: GameView }) {
  const [url, setUrl] = useState('');
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(30);
  const [speakers, setSpeakers] = useState(2);
  const [lang, setLang] = useState<Lang>('tr');
  const [player, setPlayer] = useState<YTPlayer | null>(null);
  const [busy, setBusy] = useState(false);
  const stopTimer = useRef<number | undefined>(undefined);
  const videoId = parseYouTubeId(url);
  const mine = g.submissions.find((s) => s.playerId === g.me?.id);
  const length = end - start;
  const tooLong = length > g.maxClipSeconds;
  const invalid = !videoId || length <= 1 || tooLong;

  useEffect(() => () => window.clearInterval(stopTimer.current), []);

  const pick = (sug: Suggestion) => {
    setUrl(watchUrl(sug.youtubeId));
    setStart(0);
    setEnd(Math.min(sug.duration ?? 30, g.maxClipSeconds));
    if (/[çğıöşüÇĞİÖŞÜ]/.test(sug.title)) setLang('tr');
  };

  const now = () => Math.round((player?.getCurrentTime() ?? 0) * 10) / 10;
  const previewRange = () => {
    if (!player) return;
    player.seekTo(start, true);
    player.playVideo();
    window.clearInterval(stopTimer.current);
    stopTimer.current = window.setInterval(() => {
      if (player.getCurrentTime() >= end) {
        player.pauseVideo();
        window.clearInterval(stopTimer.current);
      }
    }, 200);
  };

  const submit = async () => {
    if (!videoId) return;
    setBusy(true);
    try {
      await send({ type: 'submitVideo', url, start, end, speakers, lang });
      setUrl('');
      toast('Video eklendi');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid-2">
      <section className="card">
        <h2 className="tape">{mine ? 'Videonu değiştir' : 'Bir video öner'}</h2>
        <Suggestions g={g} selectedId={videoId} onPick={pick} />
        <label>
          YouTube linki
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=..." />
        </label>
        {url && !videoId && <p className="error">Bu bir YouTube linki gibi görünmüyor.</p>}
        {videoId && (
          <>
            <YouTubePicker videoId={videoId} onPlayer={setPlayer} />
            <div className="range-row">
              <div>
                <span className="label">Başlangıç</span>
                <input type="number" min={0} step={0.5} value={start} onChange={(e) => setStart(Number(e.target.value))} />
                <button disabled={!player} onClick={() => setStart(now())}>
                  Şu an
                </button>
              </div>
              <div>
                <span className="label">Bitiş</span>
                <input type="number" min={0} step={0.5} value={end} onChange={(e) => setEnd(Number(e.target.value))} />
                <button disabled={!player} onClick={() => setEnd(now())}>
                  Şu an
                </button>
              </div>
              <button disabled={!player || length <= 0} onClick={previewRange}>
                ▶ Aralığı izle
              </button>
            </div>
            <p className={tooLong ? 'error' : 'muted small'}>
              Klip: {fmtTime(start)} – {fmtTime(end)} ({Math.max(0, length).toFixed(1)} sn, en fazla {g.maxClipSeconds} sn)
            </p>
          </>
        )}
        <div className="field">
          <span className="label">Videoda kaç kişi konuşuyor?</span>
          <div className="seg">
            {Array.from({ length: MAX_SPEAKERS }, (_, i) => i + 1).map((n) => (
              <button key={n} className={speakers === n ? 'on' : ''} onClick={() => setSpeakers(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="label">Videonun dili</span>
          <div className="seg">
            <button className={lang === 'tr' ? 'on' : ''} onClick={() => setLang('tr')}>
              Türkçe
            </button>
            <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>
              İngilizce
            </button>
          </div>
        </div>
        <button className="primary big" disabled={invalid || busy} onClick={submit}>
          {mine ? 'Videomu değiştir' : 'Videoyu gönder'}
        </button>
      </section>

      <section className="card">
        <h2 className="tape pink">Adaylar ({g.submissions.length})</h2>
        {g.submissions.length === 0 && <p className="muted">Henüz kimse video göndermedi.</p>}
        <div className="sub-list">
          {g.submissions.map((s) => (
            <SubmissionCard key={s.id} g={g} s={s} />
          ))}
        </div>
        {g.me?.isHost ? (
          <button className="primary big" disabled={!g.submissions.length} onClick={() => act({ type: 'openVoting' })}>
            {g.submissions.length === 1 ? 'Bu videoyla başla' : 'Oylamaya geç'}
          </button>
        ) : (
          <p className="muted">Herkes videosunu gönderince oda sahibi oylamayı başlatacak.</p>
        )}
      </section>
    </div>
  );
}
