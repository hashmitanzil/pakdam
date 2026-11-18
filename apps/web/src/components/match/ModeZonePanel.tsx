'use client';
import { OUTSIDE_ZONE_RETURN_SECONDS } from '@pakdam/shared';
import { describeMode, modeTurnsRunner } from '@pakdam/engine';
import type { MatchMode, TeamAssignment } from '@pakdam/shared';
import { formatClock } from './freshness';

/** Team-assignment mode for the HUD. 'random' and 'selected' are the
 *  engine's real TeamAssignment values, read from the room config the
 *  host set — never guessed. `undefined` covers rooms created before
 *  team assignment existed.
 *
 *  NOTE (2026-11-17): the play page renders the ModeZonePanel below
 *  in the Map tab (mode, teams and the outside-zone rule, including the
 *  30-second return countdown). The HUD bar in components/hud/HudBar
 *  carries the same mode + team-assignment line in short form, and the
 *  outside-zone countdown banner lives in components/hud/OutsideZoneBanner. */
export function teamAssignmentLabel(a: TeamAssignment | undefined): string {
  if (a === 'selected') return 'Teams: host picked';
  if (a === 'random') return 'Teams: random';
  return 'Teams: not recorded';
}

/** Mode + teams + outside-zone panel for the play HUD. Mode rules,
 *  team assignment and the outside-zone rule all come from the live
 *  room record (config + each player's actual matchRole + confirmed
 *  catches). Role flips are real: in Infection a confirmed
 *  catch flips the Runner to Hunter in the store, so the roster itself
 *  shows it. The outside-zone rule is the founder's fixed rule
 *  (OUTSIDE_ZONE_RETURN_SECONDS): 30 seconds to get back inside, or
 *  ejection — not a host setting, so this panel takes no threshold
 *  props. The countdown and the ejection are enforced in the demo
 *  store (`ejectPlayer`), not just displayed here. */
export default function ModeZonePanel({
  mode,
  teamAssignment,
  selectedHunterNames,
  hunters,
  runners,
  caughtRunnerIds,
  turnedHunterIds,
  insideZone,
  outsideSeconds,
  countdownPaused,
  hasFix,
  zoneEnabled,
}: {
  mode: MatchMode;
  teamAssignment: TeamAssignment | undefined;
  selectedHunterNames: string[];
  hunters: { playerId: string; displayName: string }[];
  runners: { playerId: string; displayName: string }[];
  /** Confirmed catches in a mode where a tag takes the Runner out. */
  caughtRunnerIds: string[];
  /** Confirmed catches in a mode where a tag flips the Runner to Hunter. */
  turnedHunterIds: string[];
  insideZone: boolean | null;
  outsideSeconds: number | null;
  /** True while the countdown is paused for poor GPS accuracy. */
  countdownPaused?: boolean;
  hasFix: boolean;
  /** False when the play zone is off (classic hide and seek) — then
   *  there is no outside-zone rule at all. */
  zoneEnabled: boolean;
}) {
  const info = describeMode(mode);
  const turns = modeTurnsRunner(mode);
  const caughtNames = runners
    .filter((r) => caughtRunnerIds.includes(r.playerId))
    .map((r) => r.displayName);
  const turnedNames = hunters
    .filter((h) => turnedHunterIds.includes(h.playerId))
    .map((h) => h.displayName);
  return (
    <section className="card" aria-label="Mode, teams and zone rules">
      <h2 style={{ marginTop: 0 }}>Mode &amp; teams</h2>
      <p>
        <strong>Mode: {info.label}</strong> — {info.short}
      </p>
      <p>{info.catchRule} {info.winRule}</p>
      <p>
        <strong>{teamAssignmentLabel(teamAssignment)}</strong>
        {teamAssignment === 'random'
          ? ' — Hunters were drawn at random when the game started.'
          : teamAssignment === 'selected'
            ? ` — the host picked the Hunters in the lobby: ${selectedHunterNames.join(', ') || 'none picked yet'}.`
            : ' — this room was created before team assignment was recorded.'}
      </p>
      <p>
        <strong>Hunters ({hunters.length}):</strong> {hunters.map((h) => h.displayName).join(', ') || 'none yet'}
        {' · '}
        <strong>Runners ({runners.length}):</strong> {runners.map((r) => r.displayName).join(', ') || 'none yet'}
      </p>
      <p className="small">
        Roles above are each player&apos;s actual assigned role from the room record — never guessed from join order.
        {turns
          ? turnedNames.length > 0
            ? ` Role flips so far: ${turnedNames.join(', ')} — tagged Runners now hunt.`
            : ' No role flips yet — no confirmed catches so far.'
          : ` ${caughtNames.length > 0 ? `Caught so far: ${caughtNames.join(', ')} — out, never flipped to Hunter.` : 'Nobody caught yet — no role flips in this mode.'}`}
      </p>

      <h2>Outside the play zone</h2>
      {!zoneEnabled ? (
        <p>No play zone in this game — no outside-zone rule applies.</p>
      ) : !hasFix ? (
        <p>No location yet — outside-zone status unknown. Share your location (or use the simulated location) to check.</p>
      ) : insideZone ? (
        <p><strong>You are inside the play zone.</strong></p>
      ) : (
        <p><strong>You are outside the play zone — head back inside.</strong></p>
      )}
      {zoneEnabled && insideZone === false && outsideSeconds !== null ? (
        <p>Outside for {formatClock(outsideSeconds)} — {Math.max(0, OUTSIDE_ZONE_RETURN_SECONDS - outsideSeconds)} s left on the return countdown{countdownPaused ? ' (paused — GPS accuracy is poor, the countdown resumes when accuracy improves)' : ''}.</p>
      ) : null}
      {zoneEnabled ? (
        <>
          <p>
            This room&apos;s rule: if you leave the play zone, a {OUTSIDE_ZONE_RETURN_SECONDS}-second countdown
            appears on your screen. Get back inside before it ends, or you are ejected from the game.
          </p>
          <p className="small">
            This status is computed on your device from your own position against the zone boundary. The
            countdown and the ejection are enforced — when the countdown reaches 0 the game ejects you
            (see the roster and results, where you are shown as ejected).
          </p>
        </>
      ) : null}
    </section>
  );
}
