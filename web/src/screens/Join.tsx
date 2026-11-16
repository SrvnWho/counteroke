import { useState } from 'react';
import type { FormEvent } from 'react';
import type { GameView } from '../../../shared/types.ts';
import { join, toast } from '../net.ts';
import { Logo, Stickers } from '../ui.tsx';

export function Join({ g }: { g: GameView }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await join(name, password);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const online = g.players.filter((p) => p.connected);
  return (
    <div className="center-screen join-screen">
      <Stickers />
      <Logo big />
      <p className="tagline">Videoyu seç, sesini kat, yıldızları topla!</p>
      <form className="card join" onSubmit={submit}>
        <label>
          Sahne adın
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoFocus placeholder="ör. Ahmet" />
        </label>
        {g.passwordRequired && (
          <label>
            Oda şifresi
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        <button className="primary big" disabled={busy || !name.trim()}>
          Sahneye çık!
        </button>
        {online.length > 0 && (
          <p className="muted small">
            Kulisteler: {online.map((p) => p.name).join(', ')}
          </p>
        )}
      </form>
    </div>
  );
}
