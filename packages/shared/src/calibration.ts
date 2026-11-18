/**
 * CALIBRATION — ALL VALUES OPEN. DO NOT TREAT AS MEASURED FACTS.
 * Pack v2 / v2.1 rule: GPS accuracy tiers, catch distance, ping schedule,
 * grace, catch-token TTL, rate limits are fixed ONLY by field/measurement
 * evidence. The numbers below are PLACEHOLDERS so the code can run and be
 * tested; every one must be replaced by a measured value before the
 * external pilot, and the replacement must be recorded with its evidence.
 */
export interface Calibration {
  /** Placeholder only. Browser accuracy distribution must be recalibrated (HNT-034, OD-041). */
  accuracyGoodMaxM: number; accuracyFairMaxM: number; accuracyPoorMaxM: number;
  /** Placeholder only. Catch proximity is plausibility, NEVER proof (HNT-053). */
  catchProximityPlausibilityM: number;
  /** Placeholder only. */
  catchTokenTtlSeconds: number;
  pingIntervalSeconds: number; pingAccelerationSeconds: number;
  disconnectGraceSeconds: number; suspensionFreshnessSeconds: number;
  /** Placeholder only. Repeated suspension -> host check-in (v2.1 Issue 3). */
  suspensionCountBeforeHostCheckin: number;
  /** Placeholder only. Pending ping lifetime (v2.1 Issue 9). */
  pendingPingTtlSeconds: number;
  quickPresetDurationSeconds: number; // Quick preset numeric duration — OPEN in v3
  headStartSeconds: number; standardDurationSeconds: number;
  /** Placeholder only. Zone shrink timing (Brief v2 reference: every 10 min). */
  zoneShrinkIntervalSeconds: number;
  // No outside-zone timing fields: the rule is a single fixed 30-second
  // return countdown, then ejection (OUTSIDE_ZONE_RETURN_SECONDS in
  // types.ts) — a founder rule, not a calibration placeholder.
}
export const CALIBRATION_OPEN: Calibration = {
  accuracyGoodMaxM: 10, accuracyFairMaxM: 25, accuracyPoorMaxM: 60,
  catchProximityPlausibilityM: 15,
  catchTokenTtlSeconds: 120, pingIntervalSeconds: 180, pingAccelerationSeconds: 60,
  disconnectGraceSeconds: 60, suspensionFreshnessSeconds: 30,
  suspensionCountBeforeHostCheckin: 3, pendingPingTtlSeconds: 300,
  quickPresetDurationSeconds: 1800, headStartSeconds: 180, standardDurationSeconds: 3600,
  zoneShrinkIntervalSeconds: 600,
};
/** Starting size suggestion from player count — a starting point only,
 *  NOT a measured value. Formula: 200 m base + 25 m per player beyond
 *  3, capped at 1000 m (so 3 players -> 200 m, 6 -> 275 m, 16 -> 525 m,
 *  30 -> 875 m). The host checks the circle against the real ground
 *  and adjusts the stepper/slider. Calibration OPEN — field evidence
 *  may change the formula; the cap is a UI starting point, not a zone
 *  limit (there is no zone-size maximum — founder decision,
 *  2026-11-17, unlimited past 1 km). */
export function suggestZoneRadiusMeters(totalPlayers: number): number {
  return Math.min(1000, Math.max(200, 200 + 25 * (totalPlayers - 3)));
}
export function calibrationStatus(): string {
  return 'OPEN — every value in CALIBRATION_OPEN is a placeholder to be measured; none is a fixed requirement.';
}
