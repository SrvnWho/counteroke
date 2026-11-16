import { EFFECTS } from '../../../shared/constants.ts';
import type { EffectId } from '../../../shared/constants.ts';
import type { GameView, GroupView, Script } from '../../../shared/types.ts';
import { act } from '../net.ts';
import { charColor, groupLabel, myGroup, playerName } from '../util.ts';
import { PlayerTag } from '../ui.tsx';

function charStats(script: Script, id: number) {
  const lines = script.lines.filter((l) => l.speaker === id);
  const secs = lines.reduce((s, l) => s + (l.end - l.start), 0);
  return `${lines.length} replik · ${secs.toFixed(0)} sn`;
}

export function GroupCard({ g, group, editable }: { g: GameView; group: GroupView; editable: boolean }) {
  const script = g.round!.script!;
  const meId = g.me?.id ?? '';
  return (
    <div className={`card group-card ${group.members.includes(meId) ? 'mine' : ''}`}>
      <div className="group-head">
        <h3 className={`tape ${group.members.includes(meId) ? 'pink' : ''}`}>{groupLabel(group)}</h3>
        <div className="members">
          {group.members.map((m) => (
            <PlayerTag key={m} g={g} id={m} done={group.ready.includes(m)} />
          ))}
        </div>
      </div>
      <table className="roles">
        <tbody>
          {script.characters.map((c) => (
            <tr key={c.id}>
              <td>
                <span className="swatch" style={{ background: charColor(c.id) }} /> <b>{c.name}</b>
                <div className="muted small">{charStats(script, c.id)}</div>
              </td>
              <td>
                <select
                  disabled={!editable}
                  value={group.roles[c.id] ?? ''}
                  onChange={(e) => act({ type: 'setRole', groupId: group.id, characterId: c.id, playerId: e.target.value })}
                >
                  {group.members.map((m) => (
                    <option key={m} value={m}>
                      {playerName(g, m)}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select
                  disabled={!editable}
                  value={group.effects[c.id] ?? 'normal'}
                  onChange={(e) =>
                    act({ type: 'setEffect', groupId: group.id, characterId: c.id, effect: e.target.value as EffectId })
                  }
                >
                  {EFFECTS.map((ef) => (
                    <option key={ef.id} value={ef.id}>
                      {ef.label}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Casting({ g }: { g: GameView }) {
  const r = g.round!;
  const mine = myGroup(g);
  const meId = g.me?.id ?? '';
  const myChars = mine ? Object.entries(mine.roles).filter(([, p]) => p === meId).length : 0;
  const others = r.groups.filter((x) => x !== mine);
  return (
    <div>
      <div className="section-head">
        <h2 className="tape">Rol dağıtımı</h2>
        <span className="bubble">
          {r.groups.length} grup · {r.script!.characters.length} karakter
        </span>
        {g.me?.isHost && (
          <button className="primary" onClick={() => act({ type: 'openRecording' })}>
            Kayda geç
          </button>
        )}
      </div>
      {mine ? (
        <>
          <GroupCard g={g} group={mine} editable />
          {myChars > 1 && (
            <div className="hint">
              🎭 {myChars} karakteri birden seslendiriyorsun. Kaydı tek seferde yap; uygulama her karakterin repliklerine seçtiğin
              efekti otomatik uygular.
            </div>
          )}
          {myChars === 0 && <div className="hint warn">Bu grupta sana rol düşmedi. Bir karakteri kendine alabilirsin.</div>}
          <button
            className={`big ${mine.ready.includes(meId) ? '' : 'primary'}`}
            onClick={() => act({ type: 'setReady', ready: !mine.ready.includes(meId) })}
          >
            {mine.ready.includes(meId) ? 'Hazırım ✔ (geri al)' : 'Hazırım!'}
          </button>
        </>
      ) : (
        <div className="hint">Bu turda izleyicisin: gösterimde grupları puanlayabilirsin.</div>
      )}
      {others.length > 0 && <h3 className="tape mint">Diğer gruplar</h3>}
      <div className="group-grid">
        {others.map((x) => (
          <GroupCard key={x.id} g={g} group={x} editable={!!g.me?.isHost} />
        ))}
      </div>
    </div>
  );
}
