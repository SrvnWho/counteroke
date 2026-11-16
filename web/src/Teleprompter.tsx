import type { Script, ScriptLine, Word } from '../../shared/types.ts';
import { charColor } from './util.ts';

const LEAD = 3; // seconds of countdown before your line

function wordsOf(line: ScriptLine): Word[] {
  if (line.words?.length) return line.words;
  // Edited by hand: spread the words evenly over the line.
  const parts = line.text.split(/\s+/).filter(Boolean);
  const step = (line.end - line.start) / Math.max(1, parts.length);
  return parts.map((w, i) => ({ w, s: line.start + i * step, e: line.start + (i + 1) * step }));
}

export function Teleprompter({
  script,
  t,
  mine,
  names,
}: {
  script: Script;
  t: number;
  /** character ids voiced by this player */
  mine: Set<number>;
  /** characterId -> who voices it */
  names: Record<number, string>;
}) {
  const visible = script.lines.filter((l) => l.end + 0.4 >= t).slice(0, 4);
  if (!visible.length) {
    return (
      <div className="prompter">
        <div className="prompter-empty">{script.lines.length ? 'Replikler bitti 🎬' : 'Bu videoda replik yok, doğaçla!'}</div>
      </div>
    );
  }
  return (
    <div className="prompter">
      {visible.map((line, i) => {
        const isMine = mine.has(line.speaker);
        const active = t >= line.start - 0.05 && t <= line.end + 0.3;
        const until = line.start - t;
        const char = script.characters.find((c) => c.id === line.speaker);
        return (
          <div
            key={line.id}
            className={`p-line ${isMine ? 'mine' : 'other'} ${active ? 'active' : ''} ${i === 0 ? 'first' : ''}`}
            style={{ ['--c' as string]: charColor(line.speaker) }}
          >
            <div className="p-who">
              <span className="swatch" style={{ background: charColor(line.speaker) }} />
              {isMine ? 'SEN' : names[line.speaker] ?? ''} · {char?.name}
              {!active && until > 0 && until <= LEAD + 2 && <span className="p-in">{until.toFixed(1)} sn</span>}
            </div>
            <div className="p-text">
              {wordsOf(line).map((w, k) => (
                <span key={k} className={t >= w.s ? 'sung' : ''}>
                  {w.w}{' '}
                </span>
              ))}
            </div>
            {isMine && !active && until > 0 && until <= LEAD && (
              <div className="p-count">
                <div style={{ width: `${(1 - until / LEAD) * 100}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
