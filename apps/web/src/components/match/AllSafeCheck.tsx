'use client';
import { useState } from 'react';
import type { Player } from '@pakdam/shared';

/** Post-game all-safe check (23 §9A, 24 S07). Every player confirms they
 *  are safe, or flags a concern to the host (optional note, max 140 chars).
 *  State is local to this demo device and labelled as such — the lobby
 *  does not close on a silent assumption. No route history is shown here. */
export default function AllSafeCheck({ players, meId }: { players: Player[]; meId: string | null }) {
  const [safe, setSafe] = useState<Record<string, boolean>>({});
  const [helpNote, setHelpNote] = useState('');
  const [helpSent, setHelpSent] = useState(false);
  const [error, setError] = useState('');
  const me = players.find((p) => p.playerId === meId);
  const safeCount = Object.values(safe).filter(Boolean).length;
  const pct = players.length > 0 ? Math.round((safeCount / players.length) * 100) : 0;
  const markSafe = (id: string) => setSafe((s) => ({ ...s, [id]: true }));
  const sendHelp = () => {
    if (helpNote.length > 140) { setError('Note is too long — 140 characters or fewer.'); return; }
    setError('');
    setHelpSent(true);
  };
  return (
    <section className="card" aria-label="Everyone safe check">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Everyone safe?</h2>
        <span className="tag">{safeCount} of {players.length} safe</span>
      </div>
      <p>Before the lobby closes, every player confirms they are safe. This check is recorded on this device, not claimed as a server confirmation.</p>
      <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${safeCount} of ${players.length} players have confirmed they are safe`} style={{ height: 12, borderRadius: 999, background: '#E8CFCF', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: '#166534' }} />
      </div>
      <p><strong>{safeCount} of {players.length} players have confirmed they are safe.</strong></p>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {players.map((p) => (
          <li key={p.playerId} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', padding: '6px 0', borderBottom: '1px solid #E8CFCF' }}>
            <span aria-hidden="true">{safe[p.playerId] ? '✓' : '○'}</span>
            <strong>{p.displayName}</strong>
            <span>— {safe[p.playerId] ? '✓ Safe — confirmed' : 'Not confirmed yet'}</span>
            {meId === p.playerId && !safe[p.playerId] ? (
              <button type="button" className="btn btn-secondary" style={{ minHeight: 48 }} onClick={() => markSafe(p.playerId)}>I’m safe</button>
            ) : null}
          </li>
        ))}
      </ul>
      {!me ? <p className="small">You are not signed in as a player on this device, so you cannot confirm for anyone. Join the lobby on your own phone to confirm.</p> : null}
      <h3>I need help — tell the host</h3>
      {helpSent ? (
        <p role="status"><strong>Your message was noted for the host.</strong> If you are in danger, call your local emergency number — Pakdam is not an emergency service.</p>
      ) : (
        <>
          <label className="label" htmlFor="help-note">Optional note to the host (max 140 characters)</label>
          <textarea id="help-note" className="input" rows={2} maxLength={140} value={helpNote} onChange={(e) => setHelpNote(e.target.value)} placeholder="e.g. I am at the meeting point and need help getting back" />
          <p className="small">{helpNote.length}/140 characters.</p>
          {error ? <p role="alert">{error}</p> : null}
          <p><button type="button" className="btn btn-secondary" onClick={sendHelp}>I need help — tell the host</button></p>
        </>
      )}
    </section>
  );
}
