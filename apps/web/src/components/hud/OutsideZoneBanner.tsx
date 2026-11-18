'use client';
import { OUTSIDE_ZONE_RETURN_SECONDS } from '@pakdam/shared';
import { outsideZoneReturnRemainingSeconds } from '@pakdam/engine';

/**
 * Outside-zone banner (founder rule, 2026-11-17 — FINAL, replaces the
 * old SCRAM live/tag thresholds): a player outside the play
 * zone gets a 30-second return countdown on THEIR screen. Get back
 * inside before it ends, or they are EJECTED from the game.
 *
 * This banner is the DISPLAY. The enforcement lives in the demo store
 * (`ejectPlayer`): when the countdown reaches 0 the play screen ejects
 * the player — they are marked ejected, out of play, and shown as
 * ejected in the roster and results. The countdown and the ejection
 * both actually happen; neither is a UI state only.
 */
export default function OutsideZoneBanner({
  insideZone,
  outsideSeconds,
  hasFix,
  countdownPaused,
  accuracyMeters,
}: {
  insideZone: boolean | null;
  outsideSeconds: number | null;
  hasFix: boolean;
  /** True while the fix is too coarse to trust the outside reading —
   *  the countdown is frozen, not running, and the banner says so. */
  countdownPaused?: boolean;
  accuracyMeters?: number | null;
}) {
  if (!hasFix) {
    return (
      <div className="banner" role="status">
        <strong>Zone check needs your location.</strong> No fix yet, so we cannot tell whether you are
        inside the zone. Allow location or use the simulated location to check.
      </div>
    );
  }
  if (insideZone !== false || outsideSeconds === null) return null;
  const remaining = outsideZoneReturnRemainingSeconds(outsideSeconds, OUTSIDE_ZONE_RETURN_SECONDS);
  if (countdownPaused) {
    return (
      <div className="banner" role="alert" style={{ fontSize: 18 }}>
        <strong style={{ fontSize: 20 }}>Countdown paused — GPS accuracy is poor{accuracyMeters != null ? ` (±${Math.round(accuracyMeters)} m)` : ''}</strong>
        <div style={{ fontSize: 34, fontWeight: 800, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }} aria-label={`${remaining} seconds left to get back inside`}>
          0:{String(remaining).padStart(2, '0')} — paused
        </div>
        <p style={{ margin: '6px 0 0' }}>
          You are outside the zone, but your GPS fix is too coarse to trust — the return countdown is
          paused at {remaining} s left, not running. Move to open sky so GPS can lock, and the countdown
          resumes when accuracy improves. You are not ejected while it is paused.
        </p>
      </div>
    );
  }
  return (
    <div className="banner" role="alert" style={{ fontSize: 18 }}>
      <strong style={{ fontSize: 20 }}>Get back inside the zone — {remaining} s left</strong>
      <div style={{ fontSize: 34, fontWeight: 800, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }} aria-label={`${remaining} seconds left to get back inside`}>
        0:{String(remaining).padStart(2, '0')}
      </div>
      <p style={{ margin: '6px 0 0' }}>
        You have been outside for {outsideSeconds} s. If the countdown reaches 0 you are ejected from
        the game. Head back towards the boundary — the map shows the way.
      </p>
    </div>
  );
}
