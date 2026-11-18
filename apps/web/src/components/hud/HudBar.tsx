'use client';
import { formatClock } from '@/components/match/freshness';
import styles from './hud.module.css';

/**
 * SCRAM-grade floating HUD (Worker 3, 2026-11-17). Own Pakdam design —
 * deep-red header, big live timer, next-ping countdown, zone size +
 * shrink countdown, Runners-left progress bar, SOS + Safety Pause riding
 * along so safety is never a scroll away. Every value carries a word
 * label; colour is never the only signal.
 *
 * Data comes only from props the play page already holds (server end
 * time, room config, confirmed catches). Nothing here guesses a timer.
 */
export default function HudBar({
  nowMs,
  endsAt,
  phase,
  phaseLabel,
  nextPingInSeconds,
  zoneSizeText,
  shrinkInSeconds,
  shrinkLabel,
  runnersFree,
  runnersTotal,
  modeLabel,
  teamAssignmentLabel,
  paused,
  onSos,
  onPause,
}: {
  nowMs: number;
  endsAt: string | null;
  phase: string;
  phaseLabel: string;
  nextPingInSeconds: number | null;
  zoneSizeText: string;
  shrinkInSeconds: number | null;
  shrinkLabel: string | null;
  runnersFree: number;
  runnersTotal: number;
  modeLabel: string;
  teamAssignmentLabel: string;
  paused: boolean;
  onSos: () => void;
  onPause: () => void;
}) {
  const leftSeconds = endsAt ? Math.max(0, Math.floor((new Date(endsAt).getTime() - nowMs) / 1000)) : null;
  const almostOver = leftSeconds !== null && leftSeconds > 0 && leftSeconds < 120;
  const pct = runnersTotal > 0 ? Math.round((runnersFree / runnersTotal) * 100) : 0;
  return (
    <div className={styles.hudBar} role="region" aria-label="Match status">
      <div className={styles.hudTop}>
        <div style={{ minWidth: 0 }}>
          <div className={styles.hudLabel}>Time left</div>
          <span
            className={`${styles.hudTime} ${almostOver ? styles.hudTimeAlmost : ''}`}
            aria-label={`Time left: ${leftSeconds === null ? 'not started' : formatClock(leftSeconds)}`}
          >
            {leftSeconds === null ? '--:--' : formatClock(leftSeconds)}
          </span>
          {almostOver ? <div className={styles.hudPhase}>Almost over — under 2 minutes left</div> : null}
          <div className={styles.hudPhase}>
            {phaseLabel} {paused ? '· Paused' : ''}
          </div>
          <div className={styles.hudMode}>
            {modeLabel} · {teamAssignmentLabel}
          </div>
        </div>
        <div className={styles.hudSafety}>
          <button type="button" onClick={onPause} aria-label={paused ? 'Resume game' : 'Safety pause — pauses the match for everyone'}>
            {paused ? '▶ Resume' : '❚❚ Pause'}
          </button>
          <button type="button" className={styles.sos} onClick={onSos} aria-label="SOS — shares your position with the host">
            SOS
          </button>
        </div>
      </div>

      <div className={styles.hudGrid}>
        <div className={styles.hudChip}>
          <span className={styles.hudChipLabel}>Next ping</span>
          <span className={styles.hudChipValue}>
            {phase === 'ACTIVE' && nextPingInSeconds !== null ? `in ${formatClock(nextPingInSeconds)}` : '—'}
          </span>
          <span className={styles.hudChipNote}>
            {phase === 'ACTIVE' ? 'Coarse area only — never an exact pin' : 'Pings start when the match starts'}
          </span>
        </div>
        <div className={styles.hudChip}>
          <span className={styles.hudChipLabel}>Zone</span>
          <span className={styles.hudChipValue}>{zoneSizeText}</span>
          <span className={styles.hudChipNote}>
            {shrinkInSeconds !== null
              ? `Shrinks in ${formatClock(shrinkInSeconds)}${shrinkLabel ? ` — ${shrinkLabel}` : ''}`
              : (shrinkLabel ?? 'Fixed zone — no shrink scheduled')}
          </span>
        </div>
        <div className={`${styles.hudChip} ${styles.hudRunners}`}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
            <span className={styles.hudChipLabel}>Runners still free</span>
            <span className={styles.hudChipValue}>
              {runnersFree} of {runnersTotal} Runners
            </span>
          </div>
          <div
            className={styles.hudBarFill}
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${runnersFree} of ${runnersTotal} Runners still free`}
          >
            <div style={{ width: `${pct}%` }} />
          </div>
          <span className={styles.hudChipNote}>
            {runnersTotal === 0
              ? 'No Runners yet.'
              : runnersFree === 0
                ? 'Every Runner caught.'
                : runnersFree === runnersTotal
                  ? 'Nobody caught yet.'
                  : `${runnersTotal - runnersFree} caught so far.`}
          </span>
        </div>
      </div>
    </div>
  );
}
