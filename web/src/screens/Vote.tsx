import type { GameView } from '../../../shared/types.ts';
import { LiteYouTube } from '../LiteYouTube.tsx';
import { act } from '../net.ts';
import { fmtTime, playerName } from '../util.ts';

export function Vote({ g }: { g: GameView }) {
  const r = g.round!;
  const voters = g.players.filter((p) => p.connected);
  return (
    <div>
      <div className="section-head">
        <h2 className="tape pink">Hangisi seslendirilsin?</h2>
        <span className="bubble">
          {r.votedPlayerIds.length}/{voters.length} kişi oy verdi
        </span>
        {g.me?.isHost && (
          <button className="primary" onClick={() => act({ type: 'closeVoting' })}>
            Oylamayı bitir
          </button>
        )}
      </div>
      <div className="vote-grid">
        {g.submissions.map((s) => {
          const mine = s.playerId === g.me?.id;
          const voted = r.myVote === s.id;
          return (
            <div key={s.id} className={`card vote-card ${voted ? 'voted' : ''}`}>
              <LiteYouTube id={s.youtubeId} start={s.start} end={s.end} title={s.title} />
              {voted && <div className="stamp">OYUN BURADA</div>}
              <div className="title">{s.title}</div>
              <div className="muted small">
                {playerName(g, s.playerId)} · {fmtTime(s.end - s.start)} · {s.speakers} kişi · {s.lang.toUpperCase()}
              </div>
              {mine ? (
                <button disabled>Senin videon</button>
              ) : (
                <button className={voted ? '' : 'primary'} onClick={() => act({ type: 'vote', submissionId: s.id })}>
                  {voted ? 'Seçtin ✔' : 'Bunu seç!'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
