import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { MAX_SPEAKERS } from '../../../shared/constants.ts';
import type { Character, GameView, ScriptLine } from '../../../shared/types.ts';
import { OriginalClip } from '../LiteYouTube.tsx';
import { act, send, toast } from '../net.ts';
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

/** Seconds field for a line's start or end; "şu an" takes the video's current time. */
function TimeField({
  label,
  value,
  onCommit,
  getNow,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  getNow: () => number;
}) {
  const field = useDraft(value.toFixed(2), (v) => {
    const n = Number(v.replace(',', '.'));
    if (Number.isFinite(n)) onCommit(n);
  });
  return (
    <label className="time-field">
      <span>{label}</span>
      <input {...field} inputMode="decimal" aria-label={`${label} (saniye)`} />
      <button type="button" className="ghost small" onClick={() => onCommit(Math.round(getNow() * 100) / 100)}>
        şu an
      </button>
    </label>
  );
}

const LineRow = memo(function LineRow({
  line,
  characters,
  active,
  autoFocus,
  onSeek,
  getNow,
}: {
  line: ScriptLine;
  characters: Character[];
  active: boolean;
  autoFocus: boolean;
  onSeek: (line: ScriptLine) => void;
  getNow: () => number;
}) {
  const text = useDraft(line.text, (v) => act({ type: 'updateLine', lineId: line.id, text: v }));
  const [timing, setTiming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active]);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const remove = () => {
    const { start, end, speaker, text: t, words } = line;
    act({ type: 'deleteLine', lineId: line.id });
    toast(`Replik silindi: "${t.slice(0, 40) || '(boş)'}"`, {
      label: 'Geri al',
      run: () => act({ type: 'addLine', start, end, speaker, text: t, words }),
    });
  };

  return (
    <div ref={ref} className={`line-row ${active ? 'active' : ''}`} style={{ borderLeftColor: charColor(line.speaker) }}>
      <div className="line-main">
        <button className="ghost small time" onClick={() => onSeek(line)} title="Bu repliğe git">
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
        <input ref={input} className="line-text" {...text} maxLength={300} placeholder="Repliği yaz…" />
        <button
          className={`ghost small ${timing ? 'on' : ''}`}
          title="Zamanını ayarla"
          aria-label="Zamanını ayarla"
          aria-expanded={timing}
          onClick={() => setTiming(!timing)}
        >
          ⏱
        </button>
        <button className="ghost small" title="Repliği sil" aria-label="Repliği sil" onClick={remove}>
          ✕
        </button>
      </div>
      {timing && (
        <div className="line-timing">
          <TimeField label="Başlangıç" value={line.start} getNow={getNow} onCommit={(v) => act({ type: 'updateLine', lineId: line.id, start: v })} />
          <TimeField label="Bitiş" value={line.end} getNow={getNow} onCommit={(v) => act({ type: 'updateLine', lineId: line.id, end: v })} />
        </div>
      )}
    </div>
  );
});

export function ScriptEditor({ g }: { g: GameView }) {
  const r = g.round!;
  const script = r.script!;
  const video = useRef<HTMLVideoElement>(null);
  const t = useVideoTime(video);
  const [focusId, setFocusId] = useState<string | null>(null);
  const seek = useCallback((line: ScriptLine) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.max(0, line.start - 0.2);
    void v.play();
  }, []);
  const getNow = useCallback(() => video.current?.currentTime ?? 0, []);

  const addLine = async () => {
    const at = video.current?.currentTime ?? 0;
    video.current?.pause();
    try {
      const res = (await send({ type: 'addLine', start: at, end: at + 2, speaker: 0, text: '' })) as { lineId: string };
      setFocusId(res.lineId);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const activeId = script.lines.find((l) => t >= l.start && t <= l.end)?.id;
  return (
    <div className="grid-2 wide-right">
      <section className="card">
        <h2 className="tape">Senaryo masası</h2>
        <video ref={video} src={r.clip?.videoUrl} controls playsInline className="clip" />
        <div className="row tools-row">
          {r.submission && <OriginalClip sub={r.submission} at={t} label="🔊 Orijinalini buradan dinle" />}
          <button className="small" onClick={() => void addLine()} title="Videonun şu anki yerine boş bir replik ekler">
            ＋ Replik ekle (şu ana)
          </button>
        </div>
        <p className="muted small">
          Bu videoda konuşmalar kaldırıldı, müzik ve efektler duruyor. Yazıya çevirme bazen yanlış duyar ya da konuşmacıları
          karıştırır: metni ve konuşmacıyı düzeltin, ⏱ ile zamanını kaydırın. Değişiklikler herkese anında yansır.
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
          <p className="muted">Hiç konuşma bulunamadı. "＋ Replik ekle" ile kendiniz yazabilir ya da doğaçlama yapabilirsiniz!</p>
        )}
        <div className="lines">
          {script.lines.map((l) => (
            <LineRow
              key={l.id}
              line={l}
              characters={script.characters}
              active={l.id === activeId}
              autoFocus={l.id === focusId}
              onSeek={seek}
              getNow={getNow}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
