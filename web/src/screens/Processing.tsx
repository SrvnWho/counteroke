import { STAGE_LABELS } from '../../../shared/constants.ts';
import type { GameView } from '../../../shared/types.ts';
import { act } from '../net.ts';
import { playerName, thumb } from '../util.ts';

export function Processing({ g }: { g: GameView }) {
  const r = g.round!;
  const sub = r.submission;
  const clip = r.clip;
  const tally = r.voteTally ?? {};
  const votes = sub ? tally[sub.id] ?? 0 : 0;
  return (
    <div className="narrow">
      <section className="card">
        {sub && (
          <div className="winner-head">
            <img src={thumb(sub.youtubeId)} alt="" />
            <div>
              <span className="tape mint small">Kazanan video · {votes} oy</span>
              <div className="muted small">öneren {playerName(g, sub.playerId)} (+1 puan)</div>
              <h2>{sub.title}</h2>
              <div className="muted small">
                {sub.speakers} kişi · {sub.lang === 'tr' ? 'Türkçe' : 'İngilizce'}
              </div>
            </div>
          </div>
        )}
        {clip?.status === 'error' ? (
          <>
            <p className="error">{clip.error}</p>
            {g.me?.isHost ? (
              <div className="row">
                <button className="primary" onClick={() => act({ type: 'retryProcessing' })}>
                  Tekrar dene
                </button>
                <button onClick={() => act({ type: 'backToVoting' })}>Başka video seç</button>
              </div>
            ) : (
              <p className="muted">Oda sahibi tekrar deneyecek ya da başka video seçecek.</p>
            )}
          </>
        ) : (
          <>
            <div className="reel" />
            <div className="progress">
              <div style={{ width: `${Math.max(4, Math.round((clip?.progress ?? 0) * 100))}%` }} />
            </div>
            <p className="stage-text">
              {STAGE_LABELS[clip?.stage ?? 'queued'] ?? clip?.stage}
              {clip?.workerName && <span className="muted small"> · {clip.workerName}</span>}
            </p>
            {!g.workerOnline && (
              <p className="warn">
                Ses işleyici bağlı değil. Telefonda ya da bilgisayarda worker'ı başlatın, iş sırada bekliyor.
              </p>
            )}
            <p className="muted small">
              Konuşma sesi videodan ayrılıyor, müzik ve efektler kalıyor. Sonra konuşmalar yazıya çevrilip
              karakterlere bölünecek.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
