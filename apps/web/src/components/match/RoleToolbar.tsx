'use client';
import { useState } from 'react';
import type { Player } from '@pakdam/shared';
import { freshnessState, lastUpdatedLabel } from './freshness';

/** One player row with fresh/stale wording (23 §6B). Fresh = solid team
 *  marker (◆ H / ▲ R with the team name in text); stale = hollow/greyed;
 *  suspended = "Suspended — location unknown" with last-reported time.
 *  Colour is never the only signal: shape + letter + words are always shown. */
export function PlayerFreshnessRow({ player, showCatchLink }: { player: Player; showCatchLink?: React.ReactNode }) {
  const f = freshnessState(player.connectionState, player.lastFixAt);
  const isHunter = player.matchRole === 'hunter';
  const shape = isHunter ? '◆' : player.matchRole === 'runner' ? '▲' : '●';
  const letter = isHunter ? 'H' : player.matchRole === 'runner' ? 'R' : '?';
  const teamName = isHunter ? 'Hunter' : player.matchRole === 'runner' ? 'Runner' : 'No role yet';
  const chipStyle: React.CSSProperties =
    f.kind === 'fresh'
      ? { background: '#F0FDF4', borderColor: '#166534', color: '#166534' }
      : f.kind === 'stale'
        ? { background: '#FEF3C7', borderColor: '#92400E', color: '#78350F' }
        : f.kind === 'suspended'
          ? { background: '#FDECEC', borderColor: '#B91C1C', color: '#7F1D1D' }
          : { background: '#fff', borderColor: '#6B4A4A', color: '#6B4A4A' };
  const chipWord = f.kind === 'fresh' ? '● Fresh' : f.kind === 'stale' ? '◐ Stale' : f.kind === 'suspended' ? '○ Suspended' : '○ Unknown';
  return (
    <li className={`player-row player-${f.kind}`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' }}>
      <span className={`team-marker ${f.kind === 'fresh' ? 'marker-solid' : 'marker-hollow'}`} aria-hidden="true">
        {shape} {letter}
      </span>{' '}
      <strong>{player.displayName}</strong> {player.isHost ? <span className="tag">Host</span> : null}{' '}
      <span>— {teamName}</span>{' '}
      <span className="tag" style={chipStyle}>{chipWord}</span>{' '}
      <span>{f.label}</span>
      {player.suspensionCount > 0 ? <span> · suspended {player.suspensionCount}×</span> : null}
      {player.connectionState === 'suspended' ? <span> · {lastUpdatedLabel(player.lastFixAt)}</span> : null}
      {showCatchLink ? <> {showCatchLink}</> : null}
    </li>
  );
}

/** Silence alarm (23 §9A): a lobby-wide banner when a player's position
 *  has stopped arriving. Plain language, never an accusation — a frozen
 *  marker is a connectivity problem, not cheating. */
export function SilenceBanner({ players }: { players: Player[] }) {
  const silent = players.filter(
    (p) => p.connectionState === 'suspended' || (p.lastFixAt !== null && Date.now() - new Date(p.lastFixAt).getTime() > 3 * 60000),
  );
  if (silent.length === 0) return null;
  return (
    <div className="banner" role="status">
      <strong>Location stopped for {silent.length} player{silent.length === 1 ? '' : 's'}.</strong>{' '}
      {silent.map((p) => `${p.displayName} — ${lastUpdatedLabel(p.lastFixAt)}`).join('; ')}. Their last position is not shown as live. The host has been prompted to check in with them.
    </div>
  );
}

/** Role-split toolbars (23 §6B). A tool that belongs to the other role is
 *  not shown at all — never greyed out. Quick signals are preset buttons
 *  only (no free text), and in this demo they are local-only: they are
 *  labelled as sent to teammates, never claimed as delivered server-side.
 *  One primary action per role, full-width in the thumb zone. */
const SIGNALS = ['I need help', 'Regroup', 'All clear', 'Zone is shrinking — move in'] as const;

export function RoleToolbar({
  role, isHost, onCatch, onSafeCheckin, onSignal,
}: {
  role: 'hunter' | 'runner' | null;
  isHost: boolean;
  onCatch: () => void;
  onSafeCheckin: () => void;
  onSignal: (signal: string) => void;
}) {
  const [sent, setSent] = useState<string | null>(null);
  if (!role) return <p className="small">Your role is assigned when the match starts. Role tools appear here.</p>;
  const send = (s: string) => {
    setSent(s);
    onSignal(s);
  };
  return (
    <div className="card toolbar" role="group" aria-label={`${role === 'hunter' ? 'Hunter' : 'Runner'} tools`}>
      <h2 style={{ marginTop: 0 }}>{role === 'hunter' ? '◆ Hunter tools' : '▲ Runner tools'}</h2>
      {role === 'hunter' ? (
        <>
          <p className="small">Approximate-area radar and hot/cold readout are above. Catch needs the Runner’s QR scan (or their manual confirm if your camera can’t scan) — GPS alone never proves a catch.</p>
          <p><button className="btn" type="button" onClick={onCatch} style={{ width: '100%', padding: 16, fontSize: 18 }}>Catch — pick a Runner</button></p>
        </>
      ) : (
        <>
          <p className="small">You see the zone and the way-back guide — never other players’ positions. The nearest-Hunter banner below is the only threat readout, and it is coarse by design.</p>
          <p><strong>Nearest Hunter:</strong> not shared with Runners — no live Hunter positions are sent to Runners. This banner shows a coarse distance band only, never an exact pin.</p>
          <p><button className="btn" type="button" onClick={onSafeCheckin} style={{ width: '100%', padding: 16, fontSize: 18 }}>I’m safe — check in</button></p>
        </>
      )}
      <h3>Quick signals (teammates only)</h3>
      <div className="signal-row">
        {SIGNALS.map((s) => (
          <button key={s} type="button" className="btn btn-secondary" style={{ minHeight: 48 }} onClick={() => send(s.trim())}>{s.trim()}</button>
        ))}
      </div>
      {sent ? <p role="status">Signal “{sent}” tapped — shown to teammates on this device, not claimed as delivered.</p> : null}
      {isHost ? <p className="small">You are also the host — host check-ins are on the play screen below the map.</p> : null}
    </div>
  );
}
