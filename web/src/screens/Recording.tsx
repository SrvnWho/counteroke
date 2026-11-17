import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { EFFECTS } from '../../../shared/constants.ts';
import type { EffectId } from '../../../shared/constants.ts';
import type { GameView, Script } from '../../../shared/types.ts';
import { OriginalClip } from '../LiteYouTube.tsx';
import { act, getSession, serverNow, toast } from '../net.ts';
import { audioCtx, decodeTake, openMic, playPreview, recordTake } from '../recorder.ts';
import type { Take, TakeHandle } from '../recorder.ts';
import { deleteTake, loadTakes, saveTake } from '../takeStore.ts';
import { Teleprompter } from '../Teleprompter.tsx';
import { Avatar, Countdown, PlayerTag } from '../ui.tsx';
import { useLineTakes } from '../useLineTakes.ts';
import { charColor, groupLabel, myGroup, playerById, playerName, storedNumber, storeNumber, useNow, useVideoTime } from '../util.ts';

type Stage = 'idle' | 'countdown' | 'recording' | 'review';
type Mode = 'lines' | 'full';
const SYNC_KEY = 'counteroke.syncMs';
const MODE_KEY = 'counteroke.recMode';

function storedMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'full' ? 'full' : 'lines';
  } catch {
    return 'lines';
  }
}

function GroupStatus({ g }: { g: GameView }) {
  return (
    <div className="status-list">
      {g.round!.groups.map((grp) => (
        <div key={grp.id} className="status-row">
          <b>{groupLabel(grp)}</b>
          {grp.members.map((m) => (
            <PlayerTag key={m} g={g} id={m} done={grp.recorded.includes(m)} />
          ))}
        </div>
      ))}
    </div>
  );
}

// The parts below redraw many times a second. Keeping them in their own small components means only
// they redraw, not the whole recording screen (smoother on weak phones, no stutter while recording).

/** Karaoke script that follows the video. */
function LivePrompter(props: {
  video: RefObject<HTMLVideoElement | null>;
  script: Script;
  mine: Set<number>;
  names: Record<number, string>;
}) {
  const t = useVideoTime(props.video);
  return <Teleprompter script={props.script} t={t} mine={props.mine} names={props.names} />;
}

/** Microphone level bar, updated straight in the page without re-rendering anything. */
function MicMeter({ stream }: { stream: MediaStream }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const c = audioCtx();
    const source = c.createMediaStreamSource(stream);
    const analyser = c.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let raf = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += v * v;
      if (bar.current) bar.current.style.width = `${Math.round(Math.min(1, Math.sqrt(sum / data.length) * 4) * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
    };
  }, [stream]);
  return (
    <div className="meter" title="Mikrofon seviyesi">
      <div ref={bar} />
    </div>
  );
}

/** 3-2-1 over the video until the given server time. */
function CountdownOverlay({ to }: { to: number }) {
  useNow(100);
  return (
    <div className="overlay dim">
      <Countdown seconds={Math.max(0, (to - serverNow()) / 1000)} />
    </div>
  );
}

async function putAudio(path: string, roundId: string, blob: Blob, mime: string, trimMs: number) {
  const s = getSession();
  if (!s) throw new Error('Oturum yok');
  const res = await fetch(`${path}?round=${encodeURIComponent(roundId)}&trimMs=${Math.round(trimMs)}`, {
    method: 'PUT',
    headers: { 'content-type': mime, 'x-player': s.playerId, 'x-secret': s.secret },
    body: blob,
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; data?: { url?: string } };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.data;
}

export function Recording({ g }: { g: GameView }) {
  const r = g.round!;
  const script = r.script!;
  const group = myGroup(g);
  const meId = g.me!.id;

  const video = useRef<HTMLVideoElement>(null);

  const [mic, setMic] = useState<MediaStream | null>(null);
  const [micError, setMicError] = useState('');
  const [mode, setModeState] = useState<Mode>(storedMode);
  const [uploading, setUploading] = useState(false);
  const [manualMs, setManualMs] = useState(() => storedNumber(SYNC_KEY, 0));
  const [fxUrl, setFxUrl] = useState<string | null>(null);
  const [fxBusy, setFxBusy] = useState(false);

  // "Tek seferde" (whole clip in one go) state
  const [stage, setStage] = useState<Stage>('idle');
  const [countdownTo, setCountdownTo] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [voice, setVoice] = useState<AudioBuffer | null>(null);
  const handle = useRef<TakeHandle | null>(null);
  const startTimer = useRef<number | undefined>(undefined);
  const stopPreview = useRef<(() => void) | null>(null);
  const seenTake = useRef<number | undefined>(group?.takeStartAt);
  const fullKey = `${r.id}:${meId}:full`;

  const myChars = useMemo(
    () => new Set(Object.entries(group?.roles ?? {}).filter(([, p]) => p === meId).map(([c]) => Number(c))),
    [group?.roles, meId],
  );
  const names = useMemo(() => {
    const out: Record<number, string> = {};
    for (const [c, p] of Object.entries(group?.roles ?? {})) out[Number(c)] = playerName(g, p);
    return out;
  }, [group?.roles, g]);
  const sent = !!group?.recorded.includes(meId);

  // "Replik replik": the group goes through the lines together
  const lines = useLineTakes({
    script,
    video,
    mic,
    mine: myChars,
    group,
    meId,
    roundId: r.id,
    enabled: mode === 'lines' && stage === 'idle',
    onError: toast,
    onRestored: (n) => toast(`Sayfa yenilenmeden önceki ${n} replik kaydın geri yüklendi`),
  });

  // A whole-clip take kept in the browser comes back after a refresh.
  useEffect(() => {
    if (mode !== 'full') return;
    let cancelled = false;
    void loadTakes(fullKey).then(async (saved) => {
      const tk = saved[0]?.[1];
      if (cancelled || !tk || tk.autoTrimMs === undefined) return;
      setTake({ blob: tk.blob, mime: tk.mime, autoTrimMs: tk.autoTrimMs });
      setStage((st) => (st === 'idle' ? 'review' : st));
      setVoice(await decodeTake(tk.blob).catch(() => null));
      toast('Sayfa yenilenmeden önceki kaydın geri yüklendi');
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullKey]);

  const busy = stage === 'countdown' || stage === 'recording' || lines.phase !== 'idle' || uploading || fxBusy;

  useEffect(
    () => () => {
      window.clearTimeout(startTimer.current);
      handle.current?.abort();
      stopPreview.current?.();
      mic?.getTracks().forEach((tr) => tr.stop());
    },
    [mic],
  );

  const setMode = (m: Mode) => {
    setModeState(m);
    setFxUrl(null);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
  };

  const enableMic = async () => {
    setMicError('');
    try {
      setMic(await openMic());
    } catch (e) {
      setMicError(
        (e as Error).name === 'NotAllowedError'
          ? 'Mikrofon izni verilmedi. Tarayıcının adres çubuğundaki kilit simgesinden izin ver.'
          : `Mikrofon açılamadı: ${(e as Error).message}`,
      );
    }
  };

  const begin = (atServerMs: number) => {
    const v = video.current;
    if (!v || !mic) return;
    stopPreview.current?.();
    v.pause();
    v.currentTime = 0;
    setTake(null);
    setVoice(null);
    setFxUrl(null);
    void deleteTake(fullKey);
    setStage('countdown');
    setCountdownTo(atServerMs);
    window.clearTimeout(startTimer.current);
    startTimer.current = window.setTimeout(() => {
      setStage('recording');
      const h = recordTake(mic, v);
      handle.current = h;
      h.done
        .then(async (tk) => {
          handle.current = null;
          setTake(tk);
          setStage('review');
          void saveTake(fullKey, { blob: tk.blob, mime: tk.mime, autoTrimMs: tk.autoTrimMs });
          setVoice(await decodeTake(tk.blob).catch(() => null));
        })
        .catch((e: Error) => {
          handle.current = null;
          if (e.name !== 'AbortError') toast(`Kayıt hatası: ${e.message}`);
          setStage('idle');
        });
    }, Math.max(0, atServerMs - serverNow()));
  };

  // A group member pressed "Grupça başlat": everyone in the group starts together.
  useEffect(() => {
    const at = group?.takeStartAt;
    if (!at || at === seenTake.current) return;
    seenTake.current = at;
    if (at < serverNow() - 500) return;
    if (mode !== 'full') return toast('Grubun "Tek seferde" kayda başladı. Katılmak için o moda geç.');
    if (!mic) return toast('Grubun kaydı başlıyor ama mikrofonun kapalı!');
    if (stage !== 'idle' || busy) return toast('Grubun yeni bir kayıt başlattı; önce elindeki kaydı gönder ya da sil.');
    begin(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group?.takeStartAt]);

  // Space starts your line, Escape cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode !== 'lines' || !mic) return;
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (['input', 'select', 'textarea', 'button'].includes(tag)) return;
      if (e.code === 'Space' && !busy && stage === 'idle') {
        e.preventDefault();
        lines.start();
      } else if (e.code === 'Escape' && lines.phase !== 'idle') {
        lines.phase === 'listening' ? lines.stopListening() : lines.cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const cancel = () => {
    window.clearTimeout(startTimer.current);
    handle.current?.abort();
    video.current?.pause();
    setStage('idle');
  };

  const preview = () => {
    if (!video.current || !voice || !take) return;
    stopPreview.current?.();
    stopPreview.current = playPreview(video.current, voice, take.autoTrimMs + manualMs);
  };

  const changeSync = (v: number) => {
    setManualMs(v);
    storeNumber(SYNC_KEY, v);
    setFxUrl(null);
  };

  /** What would be sent right now: the line takes merged (and compressed), or the single full take. */
  const current = async (): Promise<{ blob: Blob; mime: string; trimMs: number } | null> => {
    if (mode === 'lines') {
      const file = await lines.encode();
      return file ? { ...file, trimMs: manualMs } : null;
    }
    return take ? { blob: take.blob, mime: take.mime, trimMs: take.autoTrimMs + manualMs } : null;
  };

  const upload = async () => {
    stopPreview.current?.();
    lines.stopListening();
    setUploading(true);
    try {
      const c = await current();
      if (!c) return;
      await putAudio('/api/recording', r.id, c.blob, c.mime, c.trimMs);
      toast('Kaydın gönderildi 🎉');
      if (mode === 'full') {
        setTake(null);
        setVoice(null);
        setStage('idle');
        void deleteTake(fullKey);
      }
    } catch (e) {
      toast(`Gönderilemedi: ${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  /** Renders your take with your effects on the server, without sending it. */
  const previewWithEffects = async () => {
    stopPreview.current?.();
    lines.stopListening();
    setFxBusy(true);
    setFxUrl(null);
    try {
      const c = await current();
      if (!c) return;
      const data = await putAudio('/api/preview', r.id, c.blob, c.mime, c.trimMs);
      setFxUrl(data?.url ?? null);
    } catch (e) {
      toast(`Ön izleme hazırlanamadı: ${(e as Error).message}`);
    } finally {
      setFxBusy(false);
    }
  };

  if (!group) {
    return (
      <div className="narrow">
        <section className="card">
          <h2 className="tape">Gruplar kayıtta</h2>
          <p className="muted">Bu turda izleyicisin. Kayıtlar bitince gösterim başlayacak.</p>
          <GroupStatus g={g} />
        </section>
      </div>
    );
  }

  const counting = stage === 'countdown' || lines.phase === 'countdown';
  const recording = stage === 'recording' || lines.phase === 'recording';
  const n = lines.lines.length;
  const curLine = lines.lines[lines.cursor];
  const curOwner = playerById(g, lines.ownerOf(lines.cursor) ?? '');
  const takeOwner = lines.take ? playerById(g, lines.take.by) : undefined;
  const canSend = mode === 'lines' ? lines.myRecordedCount > 0 && lines.phase === 'idle' : stage === 'review' && !!take;

  const sendBlock = (
    <>
      <label className="small">
        Senkron ayarı: {manualMs > 0 ? '+' : ''}
        {manualMs} ms
        <input type="range" min={-400} max={400} step={10} value={manualMs} onChange={(e) => changeSync(Number(e.target.value))} />
        <span className="muted">Sesin geç kalıyorsa sağa, erken geliyorsa sola çek.</span>
      </label>
      <button disabled={busy} onClick={previewWithEffects}>
        {fxBusy ? 'Efektler uygulanıyor…' : '✨ Efektli dinle'}
      </button>
      {fxUrl && (
        <div className="fx-preview">
          <span className="tape mint small">Efektli ön izleme · henüz gönderilmedi</span>
          <video src={fxUrl} controls autoPlay playsInline className="clip small-clip" />
        </div>
      )}
      <button className="primary big" onClick={upload} disabled={busy}>
        {uploading
          ? 'Gönderiliyor…'
          : mode === 'lines' && lines.myRecordedCount < lines.myLineCount
            ? `Eksiklerle gönder (${lines.myRecordedCount}/${lines.myLineCount})`
            : sent
              ? 'Yeniden gönder'
              : 'Gönder'}
      </button>
    </>
  );

  return (
    <div className="grid-2 wide-left">
      <section className="card stage">
        <div className="video-wrap">
          <video ref={video} src={r.clip?.videoUrl} playsInline controls={!busy && stage === 'idle'} className="clip" />
          {counting && <CountdownOverlay to={stage === 'countdown' ? countdownTo : lines.countTo} />}
          {recording && <div className="rec-badge">KAYIT</div>}
          {lines.phase === 'following' && takeOwner && <div className="rec-badge follow">{takeOwner.name} okuyor</div>}
        </div>
        <LivePrompter video={video} script={script} mine={myChars} names={names} />
        {r.submission && !busy && (
          <OriginalClip
            key={mode === 'lines' ? curLine?.id : 'full'}
            sub={r.submission}
            at={mode === 'lines' && curLine ? curLine.start : 0}
            label={mode === 'lines' && curLine ? '🔊 Bu repliğin orijinali' : '🔊 Orijinali dinle'}
          />
        )}
      </section>

      <aside className="card side">
        <h3 className="tape">{groupLabel(group)} · senin rollerin</h3>
        <div className="my-chars">
          {[...myChars].map((c) => (
            <div key={c} className="char-row">
              <span className="swatch" style={{ background: charColor(c) }} />
              <b>{script.characters.find((x) => x.id === c)?.name}</b>
              <select
                value={group.effects[c] ?? 'normal'}
                onChange={(e) => {
                  setFxUrl(null);
                  act({ type: 'setEffect', groupId: group.id, characterId: c, effect: e.target.value as EffectId });
                }}
              >
                {EFFECTS.map((ef) => (
                  <option key={ef.id} value={ef.id}>
                    {ef.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {myChars.size === 0 && <p className="muted small">Bu grupta rolün yok, kayıt yapman gerekmiyor.</p>}
        </div>

        {!mic ? (
          <>
            <div className="hint">🎧 Kulaklık tak. Hoparlörden çıkan ses mikrofona girerse kayıtta iki kere duyulur.</div>
            <button className="primary big" onClick={enableMic}>
              Mikrofonu aç
            </button>
            {micError && <p className="error">{micError}</p>}
          </>
        ) : (
          <MicMeter stream={mic} />
        )}

        {mic && (
          <div className="seg mode-tabs">
            <button className={mode === 'lines' ? 'on' : ''} disabled={busy || stage === 'review'} onClick={() => setMode('lines')}>
              Replik replik
            </button>
            <button className={mode === 'full' ? 'on' : ''} disabled={busy} onClick={() => setMode('full')}>
              Tek seferde
            </button>
          </div>
        )}

        {/* ---------------- line by line, together ---------------- */}
        {mic && mode === 'lines' && (
          <div className="stack">
            {n === 0 ? (
              <p className="muted small">Senaryoda replik yok. Serbest seslendirmek için "Tek seferde" moduna geç.</p>
            ) : (
              <>
                <div className="scene-nav">
                  <button disabled={busy || lines.cursor === 0} onClick={() => lines.go(lines.cursor - 1)}>
                    ◀ Önceki
                  </button>
                  <span className="bubble">
                    Replik {Math.min(lines.cursor + 1, n)}/{n}
                  </span>
                  <button disabled={busy || lines.cursor >= n} onClick={() => lines.go(lines.cursor + 1)}>
                    Sonraki ▶
                  </button>
                </div>

                {lines.phase === 'idle' &&
                  (lines.cursor >= n ? (
                    <div className="hint ok">Sahne bitti 🎬 Kayıtlarını dinleyip gönderebilirsin.</div>
                  ) : lines.isMine(lines.cursor) ? (
                    <>
                      <button className="pink big" disabled={busy} onClick={lines.start}>
                        🎙️ Sıra sende · Başlat
                      </button>
                      <p className="muted small">
                        Boşluk tuşu da olur. 3-2-1'den sonra video repliğinden 1,5 sn önce başlar, replik bitince durur.
                        {group.members.length > 1 && ' Grubundaki herkes aynı anda izler.'}
                      </p>
                      {curLine && lines.has(curLine.id) && (
                        <button disabled={busy} onClick={() => lines.listen(manualMs, lines.cursor)}>
                          ▶ Bu repliği dinle
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="hint">
                      Sıradaki replik: <Avatar g={g} p={curOwner} size={24} /> <b>{curOwner?.name ?? '?'}</b> ·{' '}
                      {script.characters.find((c) => c.id === curLine?.speaker)?.name}. O başlatınca hep birlikte
                      izleyeceksiniz. Gelmiyorsa "Sonraki ▶" ile atlayabilirsiniz.
                    </div>
                  ))}
                {(lines.phase === 'countdown' || lines.phase === 'recording') && lines.take?.by === meId && (
                  <div className="row">
                    {lines.phase === 'recording' && (
                      <button className="primary" onClick={lines.finish}>
                        Bitir
                      </button>
                    )}
                    <button onClick={lines.cancel}>İptal (Esc)</button>
                  </div>
                )}
                {lines.phase === 'listening' && <button onClick={lines.stopListening}>■ Durdur</button>}

                <div className="take-list">
                  {lines.lines.map((l, i) => {
                    const owner = playerById(g, lines.ownerOf(i) ?? '');
                    const done = lines.isMine(i) ? lines.has(l.id) : group.linesDone.includes(i);
                    return (
                      <button
                        key={l.id}
                        className={`take ${i === lines.cursor ? 'sel' : ''} ${done ? 'done' : ''} ${lines.isMine(i) ? 'mine' : ''}`}
                        disabled={busy}
                        onClick={() => lines.go(i)}
                        title={l.text}
                        style={{ borderLeftColor: charColor(l.speaker) }}
                      >
                        <span className="take-no">{i + 1}</span>
                        <Avatar g={g} p={owner} size={22} />
                        <span className="take-text">{l.text}</span>
                        <span className="take-state">{done ? '✔' : ''}</span>
                      </button>
                    );
                  })}
                </div>

                <p className="bubble small center-text">
                  {lines.myRecordedCount}/{lines.myLineCount} repliğin hazır
                </p>
                {lines.myRecordedCount > 0 && lines.phase === 'idle' && (
                  <button disabled={busy} onClick={() => lines.listen(manualMs)}>
                    ▶ Kendi kayıtlarımı dinle (efektsiz)
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* ---------------- whole clip in one go ---------------- */}
        {mic && mode === 'full' && stage === 'idle' && (
          <div className="stack">
            <button className="pink big" disabled={busy} onClick={() => act({ type: 'groupTake' })}>
              Grupça başlat!
            </button>
            <button disabled={busy} onClick={() => begin(serverNow() + 3000)}>
              Tek başıma, baştan sona kaydet
            </button>
            <p className="muted small">
              Video baştan sona durmadan oynar. Grupça başlatınca gruptaki herkesin kaydı aynı anda başlar.
            </p>
          </div>
        )}
        {mode === 'full' && (stage === 'countdown' || stage === 'recording') && (
          <div className="stack">
            {stage === 'recording' && (
              <button className="primary" onClick={() => handle.current?.finish()}>
                Bitir
              </button>
            )}
            <button onClick={cancel}>İptal</button>
          </div>
        )}
        {mode === 'full' && stage === 'review' && take && (
          <div className="stack">
            <button onClick={preview} disabled={!voice || busy}>
              ▶ Dinle (efektsiz)
            </button>
            <button
              onClick={() => {
                setStage('idle');
                void deleteTake(fullKey);
              }}
              disabled={busy}
            >
              Sil, tekrar kaydet
            </button>
          </div>
        )}

        {mic && canSend && <div className="stack">{sendBlock}</div>}

        {sent && !busy && <div className="hint ok">✓ Kaydın gönderildi. İstersen değiştirip yeniden gönderebilirsin.</div>}

        {group.mixUrl && (
          <>
            <h3>Grubunuzun ön izlemesi</h3>
            <video src={group.mixUrl} controls playsInline className="clip small-clip" />
          </>
        )}

        <h3>Durum</h3>
        <GroupStatus g={g} />
        {g.me?.isHost && (
          <button
            onClick={() =>
              confirm('Kayıtları bitirip gösterime geçilsin mi? Göndermeyenlerin karakterleri sessiz kalır.') &&
              act({ type: 'finishRecording' })
            }
          >
            Kaydı bitir, gösterime geç
          </button>
        )}
      </aside>
    </div>
  );
}
