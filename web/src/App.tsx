import { useEffect, useState } from 'react';
import { PHASE_LABELS } from '../../shared/constants.ts';
import type { GameView } from '../../shared/types.ts';
import { act, onToast, socket } from './net.ts';
import { Join } from './screens/Join.tsx';
import { Lobby } from './screens/Lobby.tsx';
import { Submit } from './screens/Submit.tsx';
import { Vote } from './screens/Vote.tsx';
import { Processing } from './screens/Processing.tsx';
import { ScriptEditor } from './screens/ScriptEditor.tsx';
import { Casting } from './screens/Casting.tsx';
import { Recording } from './screens/Recording.tsx';
import { Mixing } from './screens/Mixing.tsx';
import { Screening } from './screens/Screening.tsx';
import { Results } from './screens/Results.tsx';
import { ProfileDialog } from './Profile.tsx';
import { Avatar, Logo } from './ui.tsx';

function useGameState(): { g: GameView | null; connected: boolean } {
  const [g, setG] = useState<GameView | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  useEffect(() => {
    const onState = (s: GameView) => setG(s);
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    socket.on('state', onState);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('state', onState);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);
  return { g, connected };
}

function Toasts() {
  const [items, setItems] = useState<{ id: number; msg: string }[]>([]);
  useEffect(
    () =>
      onToast((msg) => {
        const id = Date.now() + Math.random();
        setItems((x) => [...x, { id, msg }]);
        setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4500);
      }),
    [],
  );
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className="toast">
          {t.msg}
        </div>
      ))}
    </div>
  );
}

function TopBar({ g, connected }: { g: GameView; connected: boolean }) {
  const players = [...g.players].sort((a, b) => b.score - a.score);
  const [editing, setEditing] = useState(false);
  return (
    <header className="topbar">
      {editing && <ProfileDialog g={g} onClose={() => setEditing(false)} />}
      <Logo />
      <div className="clapper">
        <div className="clapper-top" />
        <div className="clapper-body">
          {g.round && g.phase !== 'submit' && <b>SAHNE {g.round.number}</b>}
          <span>{PHASE_LABELS[g.phase]}</span>
        </div>
      </div>
      <div className="players-strip">
        {players.map((p) => {
          const body = (
            <>
              <Avatar g={g} p={p} size={28} />
              {p.name}
              {p.isHost && <span title="Oda sahibi">👑</span>}
              <b className="pscore">{Number.isInteger(p.score) ? p.score : p.score.toFixed(1)}</b>
            </>
          );
          return p.id === g.me?.id ? (
            <button key={p.id} className="pchip me" title="Adını ya da avatarını değiştir" onClick={() => setEditing(true)}>
              {body}
              <span className="pchip-edit" aria-hidden>
                ✏️
              </span>
            </button>
          ) : (
            <span key={p.id} className={`pchip ${p.connected ? '' : 'offline'}`} title={p.connected ? 'Bağlı' : 'Bağlantı yok'}>
              {body}
            </span>
          );
        })}
      </div>
      <div className="status">
        <span className="conn" title={connected ? 'Sunucuya bağlı' : 'Bağlantı koptu'}>
          <i className={`dot ${connected ? 'ok' : 'bad'}`} /> sunucu
        </span>
        <span className="conn" title={g.workerOnline ? 'Ses işleyici bağlı' : 'Ses işleyici bağlı değil'}>
          <i className={`dot ${g.workerOnline ? 'ok' : 'warn'}`} /> stüdyo
        </span>
        {g.me?.isHost && (
          <button
            className="ghost small"
            onClick={() => confirm('Oyun sıfırlansın mı? Puanlar ve videolar silinir.') && act({ type: 'resetGame' })}
          >
            Sıfırla
          </button>
        )}
      </div>
    </header>
  );
}

function Screen({ g }: { g: GameView }) {
  switch (g.phase) {
    case 'lobby':
      return <Lobby g={g} />;
    case 'submit':
      return <Submit g={g} />;
    case 'vote':
      return <Vote g={g} />;
    case 'processing':
      return <Processing g={g} />;
    case 'script':
      return <ScriptEditor g={g} />;
    case 'casting':
      return <Casting g={g} />;
    case 'recording':
      return <Recording g={g} />;
    case 'mixing':
      return <Mixing g={g} />;
    case 'screening':
      return <Screening g={g} />;
    case 'results':
      return <Results g={g} />;
  }
}

export function App() {
  const { g, connected } = useGameState();
  if (!g) {
    return (
      <div className="center-screen">
        <Logo big />
        <div className="reel" />
        <p className="tagline">Sunucuya bağlanılıyor…</p>
        <Toasts />
      </div>
    );
  }
  if (!g.me) {
    return (
      <>
        <Join g={g} />
        <Toasts />
      </>
    );
  }
  return (
    <div className="app">
      <TopBar g={g} connected={connected} />
      <main className="main">
        <Screen g={g} />
      </main>
      <Toasts />
    </div>
  );
}
