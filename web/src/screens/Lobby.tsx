import { useState } from 'react';
import type { GameView } from '../../../shared/types.ts';
import { act, toast } from '../net.ts';
import { ProfileDialog } from '../Profile.tsx';
import { PlaylistSetting } from '../Suggestions.tsx';
import { Avatar } from '../ui.tsx';

export function Lobby({ g }: { g: GameView }) {
  const [editing, setEditing] = useState(false);
  const link = window.location.origin;
  const copy = () =>
    navigator.clipboard.writeText(link).then(
      () => toast('Link kopyalandı'),
      () => toast(link),
    );
  const empty = Math.max(0, 4 - g.players.length);
  return (
    <div className="narrow">
      {editing && <ProfileDialog g={g} onClose={() => setEditing(false)} />}
      <section className="card">
        <h2 className="tape">Kulis</h2>
        <p>Arkadaşlarını çağır, bu linki gönder:</p>
        <div className="row">
          <code className="link">{link}</code>
          <button onClick={copy}>Kopyala</button>
        </div>
        <div className="cast-grid">
          {g.players.map((p, i) => (
            <div key={p.id} className={`cast-card ${p.connected ? '' : 'offline'}`} style={{ animationDelay: `${i * 0.06}s` }}>
              <Avatar g={g} p={p} size={64} />
              <b>{p.name}</b>
              {p.isHost && <span className="tag">oda sahibi</span>}
              {p.id === g.me?.id && (
                <button className="ghost small" onClick={() => setEditing(true)}>
                  ✏️ Düzenle
                </button>
              )}
              {!p.connected && <span className="muted small">bağlı değil</span>}
              {!p.connected && g.me?.isHost && (
                <button className="ghost small" onClick={() => act({ type: 'removePlayer', playerId: p.id })}>
                  Çıkar
                </button>
              )}
            </div>
          ))}
          {Array.from({ length: empty }, (_, i) => (
            <div key={`e${i}`} className="cast-card empty">
              Yer boş…
            </div>
          ))}
        </div>
        {g.me?.isHost && <PlaylistSetting g={g} />}
        <div className="hint">
          🎧 Herkes kulaklık taksın: kayıt sırasında hoparlörden gelen ses mikrofona girer. Sesli sohbetinizde
          kalabilirsiniz.
        </div>
        {g.me?.isHost ? (
          <button className="primary big" onClick={() => act({ type: 'startGame' })}>
            Oyunu başlat
          </button>
        ) : (
          <p className="muted">Oda sahibi oyunu başlatınca perde açılacak…</p>
        )}
      </section>
    </div>
  );
}
