import type { GameView } from '../../../shared/types.ts';
import { act } from '../net.ts';
import { groupLabel } from '../util.ts';
import { PlayerTag } from '../ui.tsx';

const LABEL = { none: 'Sırada', mixing: 'Birleştiriliyor…', ready: 'Hazır ✓', error: 'Hata' } as const;

export function Mixing({ g }: { g: GameView }) {
  const groups = g.round!.groups;
  const failed = groups.filter((x) => x.mixStatus === 'error');
  const waiting = groups.some((x) => x.mixStatus === 'mixing' || x.mixStatus === 'none');
  return (
    <div className="narrow">
      <section className="card">
        <h2 className="tape">Kurgu odası</h2>
        <p>Sesler videoya ekleniyor, birazdan gala başlıyor…</p>
        <div className="reel" />
        {groups.map((x) => (
          <div key={x.id} className="status-row">
            <b>{groupLabel(x)}</b>
            {x.members.map((m) => (
              <PlayerTag key={m} g={g} id={m} />
            ))}
            <span className={`bubble small ${x.mixStatus === 'error' ? 'error' : ''}`}>{LABEL[x.mixStatus]}</span>
            {x.mixError && <div className="error small">{x.mixError}</div>}
          </div>
        ))}
        {!waiting && failed.length > 0 && g.me?.isHost && (
          <button className="primary" onClick={() => act({ type: 'finishRecording' })}>
            Hatalı grupları tekrar dene
          </button>
        )}
      </section>
    </div>
  );
}
