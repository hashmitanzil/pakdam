'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { CSSProperties } from 'react';
import type { MatchMode } from '@pakdam/shared';
import { describeMode, zoneDiameterMeters } from '@pakdam/engine';
import { formatDistance } from '@/components/match/freshness';
import { Section, StepperRow, ToggleRow } from './controls';
import {
  CORNER_STEPS, DRAW_DEFAULT_CORNERS, DURATION_STEPS_MIN,
  HEAD_START_STEPS_S, PING_STEPS_S, RADIUS_BOUNDS,
  SHRINK_STEPS_MIN, drawnBoundaryFor, formatMinutes,
  formatRadiusCompact, formatSecondsShort, maxManualHunterCount,
  roomSummaryStrip, scaleDrawnToDiameter,
} from './draft';
import type { HostSetupDraft } from './draft';

const PlayAreaMap = dynamic(() => import('./PlayAreaMap'), { ssr: false });

/**
 * Host setup form — the ONE setup UI used by the create screen and by
 * the lobby settings sheet, so the host edits the same controls in
 * both places. Single scrolling screen, in the video's order: mode,
 * play area, players, timing, rules — no discovery section, no
 * presets. The game starts from where the host is standing — no
 * area/place-name field anywhere. Every control works; nothing is a
 * mock. Everything is free: no payment, no membership, no paywall
 * anywhere.
 *
 * Mode: two modes are playable in the pilot — Classic Manhunt and
 * Infection — picked in host setup. Breach and Zombie are later,
 * not now: they are not offered anywhere in the app.
 *
 * Removed in the video rebuild (2026-11-18): the Quick / Standard /
 * Big Park preset chips and the saved-preset save/load UI (see
 * draft.ts — presets are gone, the defaults are not); the Final size
 * Auto + % control (shrinking is always "loses a quarter of its
 * radius every N min", i.e. 75% kept per shrink); the "Hunters can
 * talk" setup toggle (voice radio is a play-screen feature — the
 * in-game radio is untouched, only the setup toggle is gone).
 * Colours, the red brand and the dark theme are untouched: this
 * rebuild is flow + wireframe only.
 *
 * The sticky CREATE LOBBY bar lives on the create page
 * (app/create/page.tsx), not here — this form is shared with the
 * lobby settings sheet, which has its own sticky DONE bar.
 *
 * The shrink controls live under "Rules" on the create screen. In
 * the lobby settings sheet they get their own "SHRINKING ZONE"
 * section instead (video frame f_015) — pass shrinkAsOwnSection
 * for that; the remaining Rules controls stay under "Rules".
 */
const cardStyle = (selected: boolean): CSSProperties => ({
  display: 'block', border: `2px solid ${selected ? 'var(--ember)' : 'var(--line)'}`,
  background: selected ? '#3A151A' : 'var(--surface)', color: 'var(--ink)', borderRadius: 12, padding: '14px 16px',
  margin: '8px 0', cursor: 'pointer',
});

export default function HostSetupForm({ value, onChange, showPresets, shrinkAsOwnSection }: {
  value: HostSetupDraft;
  onChange: (d: HostSetupDraft) => void;
  /** Accepted but ignored: presets were removed in the video rebuild
   *  (2026-11-18). Kept in the props so the lobby settings sheet —
   *  owned by Worker U2 — still typechecks until it drops the prop. */
  showPresets?: boolean;
  /** When true, the shrink controls get their own "SHRINKING ZONE"
   *  section and the rest stays under "Rules" (lobby settings
   *  sheet). Default false: everything stays under "Rules"
   *  (create screen). No other text or styling changes. */
  shrinkAsOwnSection?: boolean;
}) {
  void showPresets;
  const [howTo, setHowTo] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);

  /** Every control funnels through here. Classic and Infection
   *  carry no forced rules, so nothing here overrides the host's
   *  own stepper or toggle values. */
  const update = (patch: Partial<HostSetupDraft>) => {
    onChange({ ...value, ...patch });
  };

  const radiusSteps: number[] = [];
  // Unbounded in practice: the list always runs at least 500 m
  // past the current radius, so the + stepper never dead-ends at
  // the slider's convenience range (10 km) — the host can set any
  // radius (founder decision, 2026-11-17, unlimited past 1 km).
  const radiusStepsTop = Math.max(RADIUS_BOUNDS.max, value.radiusMeters + 500);
  for (let r = RADIUS_BOUNDS.min; r <= radiusStepsTop; r += RADIUS_BOUNDS.step) radiusSteps.push(r);
  // Manual Hunters stepper: never more Hunters than Runners — at
  // most half the room cap (15 for a 30-player room). The old bound
  // (maxPlayers − 1) allowed 29 Hunters and 1 Runner.
  const hunterSteps: number[] = [];
  for (let n = 1; n <= maxManualHunterCount(value.maxPlayers); n++) hunterSteps.push(n);

  /** Picking a mode applies it at once. */
  const changeMode = (m: MatchMode) => {
    onChange({ ...value, mode: m });
  };

  /** Shrink controls and the remaining Rules controls, as fragments
   *  so the settings sheet can head the shrink block with its own
   *  "SHRINKING ZONE" section while the create screen keeps both
   *  under "Rules". Same controls, same text, either way. */
  const shrinkControls = value.playZoneEnabled ? (
    <>
      <ToggleRow
        label="Shrinking zone"
        hint={value.zoneShrinkEnabled
          ? `The play area loses a quarter of its radius every ${formatMinutes(value.zoneShrinkIntervalSeconds / 60)}.`
          : 'The play area stays the same size all match.'}
        checked={value.zoneShrinkEnabled}
        onChange={(v) => update({ zoneShrinkEnabled: v })}
      />
      {value.zoneShrinkEnabled ? (
        <StepperRow
          label="Shrinks every" hint="How long players get between each shrink."
          steps={SHRINK_STEPS_MIN} value={value.zoneShrinkIntervalSeconds / 60} display={formatMinutes(value.zoneShrinkIntervalSeconds / 60)}
          onChange={(v) => update({ zoneShrinkIntervalSeconds: v * 60 })}
        />
      ) : null}
    </>
  ) : (
    <p className="small">No shrinking zone in this game — the play zone is off. Turn the play zone on (Play area above) to use the shrink rule.</p>
  );
  const otherRules = (
    <>
      <ToggleRow
        label="Show ping history"
        hint={value.showPingHistory ? 'Hunters see each Shadow’s earlier pings, not just the latest.' : 'Hunters see only each Shadow’s latest ping.'}
        checked={value.showPingHistory ?? false}
        onChange={(v) => update({ showPingHistory: v })}
      />
    </>
  );

  return (
    <div>
      <p className="small" style={{ marginTop: 0 }}>
        {roomSummaryStrip(value)} — updates live as you change the rules below.
      </p>

      <Section title="Mode">
        <fieldset style={{ border: 0, padding: 0, margin: '12px 0 4px' }}>
          <legend><strong>Game mode</strong></legend>
          <label style={cardStyle(value.mode === 'classic')}>
            <input type="radio" name="game-mode" checked={value.mode === 'classic'} onChange={() => changeMode('classic')} style={{ marginRight: 8, width: 20, height: 20, accentColor: '#B91C1C' }} />
            <strong>Classic</strong> — tagged Runners are out and watch live.
          </label>
          <label style={cardStyle(value.mode === 'infection')}>
            <input type="radio" name="game-mode" checked={value.mode === 'infection'} onChange={() => changeMode('infection')} style={{ marginRight: 8, width: 20, height: 20, accentColor: '#B91C1C' }} />
            <strong>Infection</strong> — tagged Runners join the Hunters.
          </label>
        </fieldset>
        <button
          type="button" className="btn btn-secondary" style={{ marginTop: 8 }}
          aria-expanded={howTo}
          onClick={() => setHowTo((h) => !h)}
        >
          {howTo ? 'Hide how to play' : 'How to play'}
        </button>
        {howTo ? (
          <span className="small" style={{ display: 'block', marginTop: 8 }}>
            {describeMode(value.mode).catchRule} {describeMode(value.mode).winRule}
          </span>
        ) : null}
      </Section>

      <Section title="Play area">
        <ToggleRow
          label="Play zone"
          hint={value.playZoneEnabled
            ? 'On — the game has a bounded play zone and scheduled pings.'
            : 'Off — no zone, no pings. Classic hide and seek.'}
          checked={value.playZoneEnabled ?? true}
          onChange={(v) => update(v
            ? { playZoneEnabled: true }
            : { playZoneEnabled: false, pingIntervalSeconds: 0, zoneShrinkEnabled: false })}
        />
        {value.playZoneEnabled ? (
          <>
            <p style={{ marginTop: 0 }}>Start from where you are standing. The zone is drawn on a real map — no place name to type.</p>
            <fieldset style={{ border: 0, padding: 0, margin: '12px 0 4px' }}>
              <legend><strong>Zone shape — Circle or Draw</strong></legend>
              <label style={cardStyle(value.zoneShape === 'circle')}>
                <input type="radio" name="zone-shape" checked={value.zoneShape === 'circle'} onChange={() => update({ zoneShape: 'circle', drawnBoundary: null })} style={{ marginRight: 8, width: 20, height: 20, accentColor: '#B91C1C' }} />
                <strong>Circle</strong> — a circle around your location.
              </label>
              <label style={cardStyle(value.zoneShape === 'draw')}>
                <input
                  type="radio" name="zone-shape" checked={value.zoneShape === 'draw'}
                  onChange={() => {
                    const boundary = value.drawnBoundary ?? drawnBoundaryFor(value, DRAW_DEFAULT_CORNERS);
                    if (boundary) update({ zoneShape: 'draw', drawnBoundary: boundary });
                    else update({ zoneShape: 'draw' });
                  }}
                  style={{ marginRight: 8, width: 20, height: 20, accentColor: '#B91C1C' }}
                />
                <strong>Draw</strong> — your own shape on the map. Drag the corners to shape it, drag the middle to move the whole zone.
              </label>
            </fieldset>
            <PlayAreaMap
              value={{ centreLat: value.centreLat, centreLng: value.centreLng, radiusMeters: value.radiusMeters, noGoAreas: value.noGoAreas, zoneShape: value.zoneShape, drawnBoundary: value.drawnBoundary }}
              onChange={(z) => { onChange({ ...value, centreLat: z.centreLat, centreLng: z.centreLng, radiusMeters: z.radiusMeters, noGoAreas: z.noGoAreas, zoneShape: z.zoneShape, drawnBoundary: z.drawnBoundary }); setFitSignal((s) => s + 1); }}
              fitSignal={fitSignal}
            />
            {value.zoneShape === 'draw' ? (
              <>
                <StepperRow
                  label="Corners" hint="Corners on the drawn shape. Changing this redraws it — drag the corners after to shape it again."
                  steps={CORNER_STEPS} value={value.drawnBoundary?.length ?? DRAW_DEFAULT_CORNERS} display={`${value.drawnBoundary?.length ?? DRAW_DEFAULT_CORNERS} corners`}
                  onChange={(v) => { const b = drawnBoundaryFor(value, v); if (b) update({ drawnBoundary: b }); }}
                />
                <p><strong>Size across:</strong> {value.drawnBoundary ? `about ${formatDistance(zoneDiameterMeters(value.drawnBoundary))} across` : 'not drawn yet'}</p>
              </>
            ) : null}
            <StepperRow
              label="Radius" hint={value.zoneShape === 'draw' ? 'Scales the whole drawn shape.' : 'Centered on your current location.'}
              steps={radiusSteps} value={value.radiusMeters} display={formatRadiusCompact(value.radiusMeters)}
              onChange={(v) => {
                if (value.zoneShape === 'draw' && value.drawnBoundary) update({ radiusMeters: v, drawnBoundary: scaleDrawnToDiameter(value.drawnBoundary, v * 2) });
                else update({ radiusMeters: v });
                setFitSignal((s) => s + 1);
              }}
            />
          </>
        ) : (
          <p className="small">No play zone in this game — and no pings. Hunters find Runners by looking. The outside-zone rule, the shrink rule and the zone map do not apply. Turn the play zone back on to use them.</p>
        )}
      </Section>

      <Section title="Players">
        <ToggleRow
          label="Balance hunters"
          hint={value.balanceHunters
            ? 'Set from the roster when the match starts — 2 for 6 players, 3 for 16.'
            : 'Off — use the Hunters stepper below instead.'}
          checked={value.balanceHunters ?? false}
          onChange={(v) => update({ balanceHunters: v })}
        />
        {value.balanceHunters ? null : (
          <StepperRow
            label="Hunters" hint="Everyone else plays as a Shadow."
            steps={hunterSteps} value={value.hunterCount}
            display={`${value.hunterCount} Hunter${value.hunterCount === 1 ? '' : 's'}`}
            onChange={(v) => update({ hunterCount: v })}
          />
        )}
        <ToggleRow
          label="Random hunters"
          hint={value.teamAssignment === 'random'
            ? 'Hunters are drawn at random when the match starts.'
            : 'You pick the Hunters yourself in the lobby, before the match starts.'}
          checked={value.teamAssignment === 'random'}
          onChange={(v) => update({ teamAssignment: v ? 'random' : 'selected', randomDraw: v })}
        />
      </Section>

      <Section title="Timing">
        <StepperRow
          label="Match length" hint="Shadows win if they last this long."
          steps={DURATION_STEPS_MIN} value={value.durationSeconds / 60} display={formatMinutes(value.durationSeconds / 60)}
          onChange={(v) => update({ durationSeconds: v * 60 })}
        />
        <StepperRow
          label="Head start" hint="Time Shadows get before Hunters are released."
          steps={HEAD_START_STEPS_S} value={value.headStartSeconds} display={formatSecondsShort(value.headStartSeconds)}
          onChange={(v) => update({ headStartSeconds: v })}
        />
        <StepperRow
          label="Location ping" hint={value.playZoneEnabled ? 'How often Hunters see where Shadows are.' : 'No pings — the play zone is off. Turn the play zone on to use pings.'}
          steps={PING_STEPS_S} value={value.pingIntervalSeconds} display={value.pingIntervalSeconds === 0 ? 'None' : formatSecondsShort(value.pingIntervalSeconds)}
          onChange={(v) => update({ pingIntervalSeconds: v })}
          disabled={!value.playZoneEnabled}
        />
      </Section>

      {shrinkAsOwnSection ? (
        <>
          <Section title="SHRINKING ZONE">
            {shrinkControls}
          </Section>
          <Section title="Rules">
            {otherRules}
          </Section>
        </>
      ) : (
        <Section title="Rules">
          {shrinkControls}
          {otherRules}
        </Section>
      )}

      <p className="small">
        Privacy: Hunters see Runners only as scheduled coarse ping areas — never exact pins. Locations are deleted at match end. Play is foreground-only: keep the app open and your screen on.
      </p>
    </div>
  );
}
