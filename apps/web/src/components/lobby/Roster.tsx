'use client';
import type { Player } from '@pakdam/shared';
import { freshnessState } from '../match/freshness';
import { isBlocked } from './report-block';
import styles from './lobby.module.css';

/** Lobby roster — redesigned 2026-11-17.
 *  Every row shows, in words as well as marks: who the player is, whether
 *  they are the host, whether they are ready, and how fresh their last
 *  location report is. Ready state is icon + word, never colour alone.
 *  Match roles are NOT assigned here and players do NOT pick a side:
 *  the host decides Hunter/Runner (Balance / Random / host-picked), so
 *  each row shows only readiness — no side preference badge.
 *  Tapping a player's name opens report / block for that player (not
 *  yourself, not the host seat's own row for the host). The host can
 *  remove a player from the lobby (not themselves, not the host seat)
 *  via `onRemove`; without it, no remove button is rendered. */
export default function Roster({
  players,
  meId,
  isHost,
  onRemove,
  onReport,
}: {
  players: Player[];
  meId?: string | null;
  isHost?: boolean;
  onRemove?: (playerId: string, displayName: string) => void;
  onReport?: (playerId: string, displayName: string) => void;
}) {
  return (
    <ul className={styles.roster}>
      {players.map((p) => {
        const fresh = freshnessState(p.connectionState, p.lastFixAt);
        const isMe = p.playerId === meId;
        const blocked = !isMe && isBlocked(p.displayName);
        const initials = p.displayName
          .trim()
          .split(/\s+/)
          .map((w) => w[0])
          .filter(Boolean)
          .slice(0, 2)
          .join('')
          .toUpperCase() || '?';
        const stateClass =
          p.ejectedAt
            ? styles.rosterStateSuspended
            : p.connectionState === 'suspended'
              ? styles.rosterStateSuspended
              : p.isReady
                ? styles.rosterStateReady
                : styles.rosterStateWaiting;
        const stateWord =
          p.ejectedAt
            ? '✕ Ejected'
            : p.connectionState === 'suspended'
              ? '✕ Suspended'
              : p.isReady
                ? '✓ Ready'
                : '… Not ready yet';
        return (
          <li key={p.playerId} className={styles.rosterRow}>
            <span className={`${styles.avatar} ${isMe ? styles.avatarMe : ''}`} aria-hidden="true">
              {initials}
            </span>
            <div className={styles.rosterMain}>
              <div className={styles.rosterName}>
                {onReport && !isMe ? (
                  <button
                    type="button"
                    className={styles.rosterNameBtn}
                    onClick={() => onReport(p.playerId, p.displayName)}
                    aria-label={`Report or block ${p.displayName}`}
                    title="Tap to report or block this player"
                  >
                    {p.displayName}
                  </button>
                ) : (
                  p.displayName
                )}
                {p.isHost ? <span className="tag">Host</span> : null}
                {isMe ? <span className="tag">You</span> : null}
                {blocked ? <span className={styles.blockedBadge}>Blocked by you</span> : null}
              </div>
              <div className={styles.rosterMeta}>
                {fresh.label}
                {p.suspensionCount > 0 ? ` · suspended ${p.suspensionCount}× before` : ''}
                {p.ejectedAt ? ' · ejected — outside the play zone for 30 seconds' : ''}
              </div>
            </div>
            <span className={`${styles.rosterState} ${stateClass}`}>{stateWord}</span>
            {isHost && onRemove && !p.isHost && p.playerId !== meId ? (
              <button
                type="button"
                className={styles.removeBtn}
                onClick={() => {
                  if (window.confirm(`Remove ${p.displayName} from this lobby? They will have to join again with the room code.`)) {
                    onRemove(p.playerId, p.displayName);
                  }
                }}
                aria-label={`Remove ${p.displayName} from the lobby`}
              >
                Remove
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
