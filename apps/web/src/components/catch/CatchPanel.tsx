'use client';
import { describeMode, modeTurnsRunner } from '@pakdam/engine';
import { pingAgeLabel } from '@/components/match/freshness';
import type { CatchEvent, MatchMode, Player } from '@pakdam/shared';

const CLAIM_LABELS: Record<string, string> = {
  requested: 'Requested — claim made, waiting for the Runner',
  'awaiting-confirmation': 'Awaiting confirmation — Runner must confirm or dispute',
  confirmed: 'Confirmed — catch counts',
  disputed: 'Disputed — host review required, match continues',
  rejected: 'Rejected — host or system rejected the claim',
  expired: 'Expired — QR ran out, request a new one',
};

/**
 * Mode-aware catch panel (Worker 3, 2026-11-17) for the live game screen.
 * Two-step, in-person tag: the Hunter tags the Runner in person, the
 * Runner taps "Got tagged" and shows their QR, the Hunter scans it to
 * complete the tag (or the Runner confirms manually when the camera
 * cannot scan); a disputed catch goes to the host. There is NO code in
 * Pakdam. The mode rule is the engine's own: Classic — tagged Runner
 * is out and watches live; Infection — tagged Runner joins the Hunters.
 *
 * Host dispute resolution: the host can confirm a disputed catch here
 * (the Runner re-confirming is the same action). There is NO "reject"
 * action in this build — the demo store has no reject/resolve-rejected
 * step, so the panel says so instead of offering a button that does
 * nothing. The QR scan and the Runner's manual confirm stay on the
 * Catch screen.
 */
export default function CatchPanel({
  mode,
  catches,
  players,
  meId,
  isHost,
  roomId,
  onConfirmCatch,
}: {
  mode: MatchMode;
  catches: CatchEvent[];
  players: Player[];
  meId: string | null;
  isHost: boolean;
  roomId: string;
  onConfirmCatch: (catchId: string) => void;
}) {
  const info = describeMode(mode);
  const turns = modeTurnsRunner(mode);
  const name = (id: string) => players.find((p) => p.playerId === id)?.displayName ?? 'A player';
  const pending = catches.filter((c) => c.state === 'requested' || c.state === 'awaiting-confirmation');
  const disputed = catches.filter((c) => c.state === 'disputed');
  const confirmed = catches.filter((c) => c.state === 'confirmed');
  const myPendingClaim = meId ? pending.find((c) => c.runnerPlayerId === meId) : undefined;
  return (
    <section className="card" aria-label="Catches">
      <h2 style={{ margin: '0 0 4px' }}>Catches — {info.label}</h2>
      <p className="small" style={{ margin: '0 0 8px' }}>
        {info.catchRule} {turns ? 'A confirmed tag flips the Runner to Hunter.' : 'A confirmed tag takes the Runner out — they watch live.'}
        {' '}GPS proximity is supporting evidence only — it never proves a catch. No grabbing, blocking,
        tackling or forced phone handling.
      </p>
      {myPendingClaim ? (
        <p role="status">
          <strong>You are the Runner in an open claim.</strong> The Hunter tagged you in person — tap
          “Got tagged” on the Catch screen to show your QR, or dispute if they did not tag you.
        </p>
      ) : null}
      {catches.length === 0 ? (
        <p>No catches yet. Hunters: tag in person, then the Runner shows their QR and you scan it to complete the tag.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {catches.map((c) => (
            <li key={c.catchId} style={{ padding: '8px 0', borderBottom: '1px solid #E8CFCF' }}>
              <span className={`claim-state claim-${c.state}`}>{CLAIM_LABELS[c.state] ?? c.state}</span>
              {' — '}
              <strong>{name(c.hunterPlayerId)}</strong> → <strong>{name(c.runnerPlayerId)}</strong>
              {' · '}requested {pingAgeLabel(c.requestedAt)}
              {c.state === 'disputed' && isHost ? (
                <span style={{ display: 'block', marginTop: 6 }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ minHeight: 44 }}
                    onClick={() => onConfirmCatch(c.catchId)}
                  >
                    Host: confirm this catch
                  </button>{' '}
                  <span className="small">
                    Confirm only after checking with both players in person. There is no reject button in
                    this build — the store has no reject step yet, so a catch you will not confirm stays
                    disputed and does not count.
                  </span>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="small" style={{ margin: '8px 0 0' }}>
        {confirmed.length} confirmed · {pending.length} waiting for the Runner · {disputed.length} disputed
        (host review).{' '}
        <a href={`/room/${roomId}/catch`}>Open the Catch screen — tag in person, then the Runner shows their QR and you scan it</a>.
      </p>
    </section>
  );
}
