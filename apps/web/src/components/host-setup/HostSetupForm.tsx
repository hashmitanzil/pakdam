'use client';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import type { CSSProperties } from 'react';
import { validateHousePreset } from '@pakdam/shared';
import type { HouseRulePreset, MatchMode } from '@pakdam/shared';
import { describeMode, zoneDiameterMeters } from '@pakdam/engine';
import { formatDistance } from '@/components/match/freshness';
import { Section, StepperRow, ToggleRow } from './controls';
import {
  BUILT_INS, CORNER_STEPS, DRAW_DEFAULT_CORNERS, DURATION_STEPS_MIN, FINAL_SIZE_STEPS,
  HEAD_START_STEPS_S, PING_STEPS_S, RADIUS_BOUNDS,
  SHRINK_STEPS_MIN, applyPresetToDraft, balancedHunterRange, drawnBoundaryFor, effectiveFinalSizePercent,
  formatMinutes,
  formatSecondsShort, loadHousePresets, maxManualHunterCount, presetIdForDraft, roomSummaryStrip,
  saveHousePresets, scaleDrawnToDiameter,
} from './draft';
import type { BuiltInPresetId, HostSetupDraft } from './draft';

const PlayAreaMap = dynamic(() => import('./PlayAreaMap'), { ssr: false });

/**
 * Host setup form — the ONE setup UI used by the create screen and by
 * the lobby settings sheet, so the host edits the same controls in
 * both places. Single scrolling screen, location first: the game
 * starts from where the host is standing — no area/place-name field
 * anywhere. Every control works; nothing is a mock. Everything is
 * free: no payment, no membership, no paywall anywhere.
 *
 * Mode: two modes are playable in the pilot — Classic Manhunt and
 * Infection — picked in host setup. Breach and Zombie are later,
 * not now: they are not offered anywhere in the app.
 */
const cardStyle = (selected: boolean): CSSProperties => ({
  display: 'block', border: `2px solid ${selected ? 'var(--ember)' : 'var(--line)'}`,
  background: selected ? '#3A151A' : 'var(--surface)', color: 'var(--ink)', borderRadius: 12, padding: '14px 16px',
  margin: '8px 0', cursor: 'pointer',
});

export default function HostSetupForm({ value, onChange, showPresets = true }: {
  value: HostSetupDraft;
  onChange: (d: HostSetupDraft) => void;
  showPresets?: boolean;
}) {
  const [preset, setPreset] = useState<'quick' | 'standard' | 'big-park' | 'custom'>(() => presetIdForDraft(value));
  const [savedPresets, setSavedPresets] = useState<HouseRulePreset[]>([]);
  const [presetName, setPresetName] = useState('');
  const [presetNote, setPresetNote] = useState('');
  const [howTo, setHowTo] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);

  useEffect(() => { setSavedPresets(loadHousePresets()); }, []);

  /** Every control funnels through here. Classic and Infection
   *  carry no forced rules, so nothing here overrides the host's
   *  own stepper or toggle values. */
  const update = (patch: Partial<HostSetupDraft>) => {
    setPreset('custom');
    onChange({ ...value, ...patch });
  };

  // Balance preview is roster-based, not a pre-set count: the range
  // Balance produces as the roster grows to the room cap (1 Hunter
  // for 3–4 players, up to 5 for 25–30). No single count exists
  // before the roster joins.
  const hunterRange = balancedHunterRange(value.maxPlayers);
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
    setPreset('custom');
    onChange({ ...value, mode: m });
  };
  const applyBuiltIn = (id: BuiltInPresetId) => {
    const b = BUILT_INS[id];
    setPreset(id);
    // In Draw mode the polygon follows the preset's size, so the map
    // and the lobby summary never disagree about the zone.
    const drawnBoundary = value.zoneShape === 'draw' && value.drawnBoundary
      ? scaleDrawnToDiameter(value.drawnBoundary, b.radiusMeters * 2)
      : value.drawnBoundary;
    onChange({
      ...value, ...b.rules, maxPlayers: value.maxPlayers,
      hunterCount: Math.min(b.rules.hunterCount, maxManualHunterCount(value.maxPlayers)),
      radiusMeters: b.radiusMeters, drawnBoundary,
    });
  };

  const savePreset = () => {
    const trimmed = presetName.trim();
    if (!trimmed) { setPresetNote('Give the preset a name first.'); return; }
    const p: HouseRulePreset = {
      presetId: `hp-${Date.now().toString(36)}`, name: trimmed,
      createdAt: new Date().toISOString(),
      rules: {
        mode: value.mode, teamAssignment: value.teamAssignment, maxPlayers: value.maxPlayers,
        hunterCount: value.hunterCount, durationSeconds: value.durationSeconds,
        headStartSeconds: value.headStartSeconds, pingIntervalSeconds: value.pingIntervalSeconds,
        zoneShrinkEnabled: value.zoneShrinkEnabled, zoneShrinkIntervalSeconds: value.zoneShrinkIntervalSeconds,
        // Fixed rule, never a saved choice.
        catchConfirmationRequired: true,
        balanceHunters: value.balanceHunters, randomDraw: value.randomDraw,
        showPingHistory: value.showPingHistory,
        playZoneEnabled: value.playZoneEnabled, huntersCanTalk: value.huntersCanTalk,
        finalSizePercent: value.finalSizePercent,
      },
      radiusMeters: value.radiusMeters,
    };
    const errs = validateHousePreset(p);
    if (errs.length) { setPresetNote(errs.join('; ')); return; }
    const next = [...savedPresets.filter((x) => x.name.toLowerCase() !== trimmed.toLowerCase()), p];
    setSavedPresets(next);
    saveHousePresets(next);
    setPresetName('');
    setPresetNote(`Saved “${trimmed}” — your house rules, on this device only.`);
  };

  const deletePreset = (id: string) => {
    const next = savedPresets.filter((x) => x.presetId !== id);
    setSavedPresets(next);
    saveHousePresets(next);
  };

  return (
    <div>
      <p className="small" style={{ marginTop: 0 }}>
        {roomSummaryStrip(value)} — updates live as you change the rules below.
      </p>

      {showPresets ? (
        <Section title="Presets">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="group" aria-label="Presets">
            {(Object.keys(BUILT_INS) as BuiltInPresetId[]).map((k) => (
              <button
                key={k} type="button" className="btn btn-secondary" aria-pressed={preset === k}
                style={preset === k ? { border: '2px solid var(--ember)', background: '#3A151A', fontWeight: 700 } : undefined}
                onClick={() => applyBuiltIn(k)}
              >
                {BUILT_INS[k].label}
              </button>
            ))}
            {savedPresets.map((p) => (
              <span key={p.presetId} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <button
                  type="button" className="btn btn-secondary"
                  onClick={() => { onChange(applyPresetToDraft(value, p)); setPreset('custom'); setPresetNote(`Loaded “${p.name}”.`); }}
                >
                  {p.name}
                </button>
                <button type="button" className="btn btn-secondary" aria-label={`Delete preset ${p.name}`} onClick={() => deletePreset(p.presetId)}>×</button>
              </span>
            ))}
            {preset === 'custom' ? (
              <span className="btn btn-secondary" aria-current="true" style={{ border: '2px solid var(--ember)', background: '#3A151A', fontWeight: 700, cursor: 'default' }}>Custom</span>
            ) : null}
          </div>
          <p className="small" style={{ margin: '8px 0 0' }}>
            {preset === 'custom'
              ? 'Custom — change any setting and it stays yours. Save it below to reuse it next time.'
              : `${BUILT_INS[preset].blurb} — ${formatMinutes(BUILT_INS[preset].rules.durationSeconds / 60)}, ${BUILT_INS[preset].rules.hunterCount} Hunter${BUILT_INS[preset].rules.hunterCount === 1 ? '' : 's'}.`}
          </p>
          <label className="label" htmlFor="preset-name" style={{ marginTop: 12 }}>Save the current settings as a preset</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input id="preset-name" className="input" value={presetName} onChange={(e) => setPresetName(e.target.value)} maxLength={40} placeholder="e.g. Sunday park game" style={{ flex: '1 1 200px', minWidth: 0, margin: 0 }} />
            <button type="button" className="btn btn-secondary" onClick={savePreset}>Save preset</button>
          </div>
          {presetNote ? <p role="status" className="small">{presetNote}</p> : null}
          <p className="small" style={{ marginBottom: 0 }}>Presets live on this device only.</p>
        </Section>
      ) : null}

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
              onChange={(z) => { setPreset('custom'); onChange({ ...value, centreLat: z.centreLat, centreLng: z.centreLng, radiusMeters: z.radiusMeters, noGoAreas: z.noGoAreas, zoneShape: z.zoneShape, drawnBoundary: z.drawnBoundary }); setFitSignal((s) => s + 1); }}
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
              label="Zone size" hint={value.zoneShape === 'draw' ? 'Scales the whole drawn shape.' : 'Centred on your location.'}
              steps={radiusSteps} value={value.radiusMeters} display={`about ${formatDistance(value.radiusMeters * 2)} across`}
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
            ? 'Set from the players who join, when the match starts.'
            : 'Off — use the Hunters stepper below instead.'}
          checked={value.balanceHunters ?? false}
          onChange={(v) => update({ balanceHunters: v })}
        />
        {value.balanceHunters ? (
          <p className="small">Balance is on: {hunterRange.min}–{hunterRange.max} Hunters, depending on how many players join (1 for 3–4 players, up to {hunterRange.max} for 25–30). The final count is set from the players who actually joined, when the match starts.</p>
        ) : (
          <StepperRow
            label="Hunters" hint="How many Hunters the match starts with — never more Hunters than Runners."
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
          label="Match length" hint="Runners win if they last this long."
          steps={DURATION_STEPS_MIN} value={value.durationSeconds / 60} display={formatMinutes(value.durationSeconds / 60)}
          onChange={(v) => update({ durationSeconds: v * 60 })}
        />
        <StepperRow
          label="Head start" hint="Time Runners get before Hunters are released."
          steps={HEAD_START_STEPS_S} value={value.headStartSeconds} display={formatSecondsShort(value.headStartSeconds)}
          onChange={(v) => update({ headStartSeconds: v })}
        />
        <StepperRow
          label="Location ping" hint={value.playZoneEnabled ? 'How often Hunters see where Runners were — a coarse area, never an exact pin.' : 'No pings — the play zone is off. Turn the play zone on to use pings.'}
          steps={PING_STEPS_S} value={value.pingIntervalSeconds} display={value.pingIntervalSeconds === 0 ? 'None' : formatSecondsShort(value.pingIntervalSeconds)}
          onChange={(v) => update({ pingIntervalSeconds: v })}
          disabled={!value.playZoneEnabled}
        />
      </Section>

      <Section title="Rules">
        {value.playZoneEnabled ? (
          <>
            <ToggleRow
              label="Shrinking zone"
              hint={value.zoneShrinkEnabled
                ? 'The play area shrinks on schedule — each shrink keeps part of its size, down to the final size below.'
                : 'The play area stays the same size all match.'}
              checked={value.zoneShrinkEnabled}
              onChange={(v) => update({ zoneShrinkEnabled: v })}
            />
            {value.zoneShrinkEnabled ? (
              <>
                <StepperRow
                  label="Shrinks every" hint="How long players get between each shrink. The next, smaller edge is previewed before each shrink."
                  steps={SHRINK_STEPS_MIN} value={value.zoneShrinkIntervalSeconds / 60} display={formatMinutes(value.zoneShrinkIntervalSeconds / 60)}
                  onChange={(v) => update({ zoneShrinkIntervalSeconds: v * 60 })}
                />
                <ToggleRow
                  label="Final size — Auto"
                  hint={value.finalSizePercent === null
                    ? `Auto: the zone ends at about ${effectiveFinalSizePercent(value)}% of its starting size (75% kept per shrink, from the shrink schedule above).`
                    : 'Auto is off — the final size below is used instead.'}
                  checked={value.finalSizePercent === null}
                  onChange={(v) => update({ finalSizePercent: v ? null : effectiveFinalSizePercent(value) })}
                />
                {value.finalSizePercent !== null ? (
                  <StepperRow
                    label="Final size" hint="How big the zone is at the last shrink, as a percentage of the starting size. The shrinks in between step down evenly toward it."
                    steps={FINAL_SIZE_STEPS} value={value.finalSizePercent} display={`${value.finalSizePercent}% of the starting size`}
                    onChange={(v) => update({ finalSizePercent: v })}
                  />
                ) : null}
              </>
            ) : null}
          </>
        ) : (
          <p className="small">No shrinking zone in this game — the play zone is off. Turn the play zone on (Play area above) to use the shrink rule.</p>
        )}
        <ToggleRow
          label="Hunters can talk"
          hint={value.huntersCanTalk
            ? 'Hunters can use Team Radio — text and quick messages on their own channel.'
            : 'Hunters’ radio is off for this game — Hunters cannot send radio messages. Runners can still use theirs.'}
          checked={value.huntersCanTalk ?? true}
          onChange={(v) => update({ huntersCanTalk: v })}
        />
        <ToggleRow
          label="Show ping history"
          hint={value.showPingHistory ? 'Hunters see each Runner’s earlier pings, not just the latest. Still coarse areas — never exact pins.' : 'Hunters see only each Runner’s latest ping.'}
          checked={value.showPingHistory ?? false}
          onChange={(v) => update({ showPingHistory: v })}
        />
        <p><strong>Outside the zone:</strong> if a player leaves the play zone, a 30-second countdown appears on their screen. Get back inside before it ends, or they are ejected from the game. This is a fixed rule, not a setting — there is nothing to adjust here.</p>
      </Section>

      <p className="small">
        Privacy: Hunters see Runners only as scheduled coarse ping areas — never exact pins. Locations are deleted at match end. Play is foreground-only: keep the app open and your screen on.
      </p>
    </div>
  );
}
