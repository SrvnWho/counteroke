import { useEffect, useRef, useState } from 'react';
import { MAX_SPEAKERS } from '../../../shared/constants.ts';
import type { Character, GameView, ScriptLine } from '../../../shared/types.ts';
import { act } from '../net.ts';
import { charColor, fmtTime, useVideoTime } from '../util.ts';

/** A text field that keeps local edits while focused and sends them on blur. */
function useDraft(value: string, commit: (v: string) => void) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  return {
    value: draft,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      if (draft.trim() !== value) commit(draft);
    },
  };
}

function CharacterRow({ c }: { c: Character }) {
  const name = useDraft(c.name, (v) => act({ type: 'renameCharacter', characterId: c.id, name: v }));
  return (
    <div className="char-row">
      <span className="swatch" style={{ background: charColor(c.id) }} />
      <input {...name} maxLength={30} />
    </div>
  );
}

function LineRow({
  line,
  characters,
  active,
  onSeek,
}: {
  line: ScriptLine;
  characters: Character[];
  active: boolean;
  onSeek: () => void;
}) {
  const text = useDraft(line.text, (v) => act({ type: 'updateLine', lineId: line.id, text: v }));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active]);
  return (
    <div ref={ref} className={`line-row ${active ? 'active' : ''}`} style={{ borderLeftColor: charColor(line.speaker) }}>
      <button className="ghost small time" onClick={onSeek} title="Bu repliğe git">
        {fmtTime(line.start)}
      </button>
      <select
        value={line.speaker}
        style={{ color: charColor(line.speaker) }}
        onChange={(e) => act({ type: 'updateLine', lineId: line.id, speaker: Number(e.target.value) })}
      >
        {characters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <input className="line-text" {...text} maxLength={300} />
      <button className="ghost small" title="Repliği sil" onClick={() => act({ type: 'deleteLine', lineId: line.id })}>
        ✕
      </button>
    </div>
  );
}

export function ScriptEditor({ g }: { g: GameView }) {
  const r = g.round!;
  const script = r.script!;
  const video = useRef<HTMLVideoElement>(null);
  const t = useVideoTime(video);
  const seek = (s: number) => {
    if (video.current) {
      video.current.currentTime = Math.max(0, s - 0.2);
      void video.current.play();
    }
  };
  return (
    <div className="grid-2 wide-right">
      <section className="card">
        <h2 className="tape">Senaryo masası</h2>
        <video ref={video} src={r.clip?.videoUrl} controls playsInline className="clip" />
        <p className="muted small">
          Bu videoda konuşmalar kaldırıldı, müzik ve efektler duruyor. Yazıya çevirme bazen yanlış duyar ya da konuşmacıları
          karıştırır: metni ve konuşmacıyı düzeltin. Değişiklikler herkese anında yansır.
        </p>
        <h3>Karakterler</h3>
        {script.characters.map((c) => (
          <CharacterRow key={c.id} c={c} />
        ))}
        <div className="field">
          <span className="label">Karakter sayısı</span>
          <div className="seg">
            {Array.from({ length: MAX_SPEAKERS }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                className={script.characters.length === n ? 'on' : ''}
                onClick={() => act({ type: 'setCharacterCount', count: n })}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        {g.me?.isHost ? (
          <button className="primary big" onClick={() => act({ type: 'openCasting' })}>
            Gruplara ve rollere geç
          </button>
        ) : (
          <p className="muted">Hazır olunca oda sahibi rol dağıtımına geçecek.</p>
        )}
      </section>
      <section className="card lines-card">
        <h2 className="tape pink">Replikler ({script.lines.length})</h2>
        {script.lines.length === 0 && (
          <p className="muted">Hiç konuşma bulunamadı. Doğaçlama yapabilirsiniz!</p>
        )}
        <div className="lines">
          {script.lines.map((l) => (
            <LineRow
              key={l.id}
              line={l}
              characters={script.characters}
              active={t >= l.start && t <= l.end}
              onSeek={() => seek(l.start)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
