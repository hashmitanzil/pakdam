'use client';
import { formatAgeAgo, freshnessState } from '@/components/match/freshness';
import type { ConnectionState } from '@pakdam/shared';
import styles from './hud.module.css';

export interface DotEntry {
  playerId: string;
  displayName: string;
  role: 'hunter' | 'runner';
  reportedAt: string | null;
  connectionState: ConnectionState;
}

/**
 * Named coarse dots (Worker 3, 2026-11-17) — the SCRAM-style roster strip:
 * a name with a freshness age ("0:27 ago", counting up), never a position.
 * Hunters see Runners; Runners see only their fellow Runners — Runners
 * never see Hunter positions, and nobody sees an exact pin. A dot stays
 * until that player's next report replaces it — it is never removed on a
 * timer (founder decision, 2026-11-17). Freshness is words (Live / Stale
 * / Suspended), never colour alone; Hunters are ◆ H solid, Runners ▲ R
 * hatched.
 */
export default function PlayerDots({
  entries,
  title,
  emptyText,
}: {
  entries: DotEntry[];
  title: string;
  emptyText: string;
}) {
  return (
    <section className="card" aria-label={title}>
      <h2 style={{ margin: '0 0 4px' }}>{title}</h2>
      <p className="small" style={{ margin: 0 }}>
        Names and last-reported times only — coarse areas on the map, never exact positions.
      </p>
      {entries.length === 0 ? (
        <p>{emptyText}</p>
      ) : (
        <ul className={styles.dotsList}>
          {entries.map((e) => {
            const fresh = freshnessState(e.connectionState, e.reportedAt);
            const marker = e.role === 'hunter' ? '◆ H' : '▲ R';
            return (
              <li key={e.playerId} className={styles.dotsRow}>
                <span>
                  <span className="team-marker" aria-label={e.role === 'hunter' ? 'Hunter' : 'Runner'}>
                    {marker}
                  </span>{' '}
                  <span className={styles.dotsName}>{e.displayName}</span>{' '}
                  <span className="small">
                    · {fresh.kind === 'fresh' ? 'Live' : fresh.kind === 'stale' ? 'Stale' : fresh.kind === 'suspended' ? 'Suspended — location unknown' : 'Location never reported'}
                  </span>
                </span>
                <span className={styles.dotsAge}>{formatAgeAgo(e.reportedAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
