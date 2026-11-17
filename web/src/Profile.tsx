import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { GameView } from '../../shared/types.ts';
import { send, toast } from './net.ts';
import { AvatarPicker } from './ui.tsx';

/** Pop-up where a player changes their name and avatar. */
export function ProfileDialog({ g, onClose }: { g: GameView; onClose: () => void }) {
  const me = g.me!;
  const [name, setName] = useState(me.name);
  const [avatar, setAvatar] = useState(me.avatar);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await send({ type: 'setProfile', name, avatar });
      onClose();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changed = name.trim() !== me.name || avatar !== me.avatar;
  return (
    <div className="modal-back" onClick={onClose}>
      <form className="card modal" onSubmit={save} onClick={(e) => e.stopPropagation()}>
        <h2 className="tape">Sahne kimliğin</h2>
        <div className="profile-preview">
          <span className="avatar" style={{ background: me.color, width: 72, height: 72, fontSize: 42 }}>
            {avatar}
          </span>
          <label>
            Sahne adın
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoFocus />
          </label>
        </div>
        <span className="label">Avatarını seç</span>
        <AvatarPicker g={g} value={avatar} onChange={setAvatar} selfId={me.id} />
        <div className="row end">
          <button type="button" className="ghost" onClick={onClose}>
            Vazgeç
          </button>
          <button className="primary" disabled={busy || !name.trim() || !changed}>
            Kaydet
          </button>
        </div>
      </form>
    </div>
  );
}
