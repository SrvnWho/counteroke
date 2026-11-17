import { useState } from 'react';
import type { FormEvent } from 'react';
import type { GameView } from '../../../shared/types.ts';
import { join, toast } from '../net.ts';
import { AvatarPicker, Logo, Stickers, randomFreeAvatar } from '../ui.tsx';

export function Join({ g }: { g: GameView }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [avatar, setAvatar] = useState(() => randomFreeAvatar(g));
  const [busy, setBusy] = useState(false);
  // typing the name of a player who dropped out takes their seat back, avatar included
  const returning = g.players.find(
    (p) => !p.connected && p.name.toLocaleLowerCase('tr') === name.trim().toLocaleLowerCase('tr'),
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await join(name, password, avatar);
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
        <div className="profile-preview">
          <span className="avatar" style={{ background: '#fff7e3', width: 72, height: 72, fontSize: 42 }}>
            {avatar}
          </span>
          <label>
            Sahne adın
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoFocus placeholder="ör. Ahmet" />
          </label>
        </div>
        <span className="label">Avatarını seç</span>
        <AvatarPicker g={g} value={avatar} onChange={setAvatar} selfId={returning?.id} />
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
