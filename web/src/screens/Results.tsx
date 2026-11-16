import { useState } from 'react';
import type { GameView } from '../../../shared/types.ts';
import { act } from '../net.ts';
import { groupLabel } from '../util.ts';
import { Avatar, Confetti, PlayerTag } from '../ui.tsx';
import { Cast, DownloadLink } from './Screening.tsx';

const STEP = 1.1; // seconds between reveals
const MEDALS = ['🏆', '🥈', '🥉'];

export function Results({ g }: { g: GameView }) {
  const r = g.round!;
  const results = r.results ?? [];
  const winners = new Set(r.winnerGroupIds ?? []);
  const [watch, setWatch] = useState<string | null>(null);
  const watching = r.groups.find((x) => x.id === watch);
  const players = [...g.players].sort((a, b) => b.score - a.score);
  const winnerNames = results
    .filter((x) => winners.has(x.groupId))
    .map((x) => groupLabel(r.groups.find((grp) => grp.id === x.groupId)!));
  const revealAt = results.length * STEP;

  return (
    <div className="grid-2 wide-left">
      {winnerNames.length > 0 && <Confetti delay={revealAt} />}
      <section className="card">
        <h2 className="tape">Ödül töreni · Sahne {r.number}</h2>
        <ol className="results">
          {results.map((res, i) => {
            const grp = r.groups.find((x) => x.id === res.groupId)!;
            const win = winners.has(res.groupId);
            return (
              <li
                key={res.groupId}
                className={`result ${win ? 'winner' : ''}`}
                style={{ animationDelay: `${(results.length - 1 - i) * STEP}s` }}
              >
                <div className="place">{win ? '🏆' : (MEDALS[i] ?? i + 1)}</div>
                <div className="who">
                  <b>{groupLabel(grp)}</b>
                  <div className="members">
                    {grp.members.map((m) => (
                      <PlayerTag key={m} g={g} id={m} />
                    ))}
                  </div>
                </div>
                <div className="score">
                  {'★'.repeat(Math.floor(res.average))}
                  <span className="muted">{'☆'.repeat(5 - Math.floor(res.average))}</span>
                  <b>{res.average.toFixed(2)}</b>
                  <span className="muted">{res.count} oy</span>
                </div>
                {grp.mixUrl && (
                  <div className="row">
                    <button className="ghost small" onClick={() => setWatch(watch === grp.id ? null : grp.id)}>
                      {watch === grp.id ? 'Kapat' : '▶ İzle'}
                    </button>
                    <DownloadLink roundNumber={r.number} group={grp} />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {winnerNames.length > 0 && (
          <div className="winner-banner" style={{ animationDelay: `${revealAt}s` }}>
            {winnerNames.join(' ve ')} kazandı!
          </div>
        )}
        {watching?.mixUrl && (
          <>
            <video src={watching.mixUrl} controls autoPlay playsInline className="clip" />
            <Cast g={g} group={watching} />
          </>
        )}
      </section>
      <aside className="card side">
        <h3 className="tape pink">Genel puan durumu</h3>
        <ol className="scoreboard">
          {players.map((p, i) => (
            <li key={p.id}>
              <span className="rank">{i + 1}</span>
              <Avatar g={g} p={p} size={30} />
              {p.name}
              <b>{p.score.toFixed(2)}</b>
            </li>
          ))}
        </ol>
        <p className="muted small">Herkes grubunun ortalama yıldızını kazanır, videosu seçilen kişi +1 alır.</p>
        {g.me?.isHost ? (
          <button className="primary big" onClick={() => act({ type: 'nextRound' })}>
            Sonraki sahne
          </button>
        ) : (
          <p className="muted">Oda sahibi sıradaki sahneyi başlatacak.</p>
        )}
      </aside>
    </div>
  );
}
