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
  SHRINK_STEPS_MIN, applyPresetToDraft, drawnBoundaryFor, effectiveFinalSizePercent,
  effectiveHunterCount, formatMinutes,
  formatPing, formatSecondsShort, loadHousePresets, roomSummaryStrip,
  saveHousePresets, scaleDrawnToDiameter, suggestedRadiusFor,
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
  display: 'block', border: `2px solid ${selected ? '#B91C1C' : '#E8CFCF'}`,
  background: selected ? '#FEE2E2' : '#FFFFFF', borderRadius: 12, padding: '14px 16px',
  margin: '8px 0', cursor: 'pointer',
});

function SliderRow({ id, label, display, min, max, step, value, onChange, hint, minLabel, maxLabel }: {
  id: string; label: string; display: string; min: number; max: number; step: number;
  value: number; onChange: (v: number) => void; hint?: string; minLabel: string; maxLabel: string;
}) {
  return (
    <div style={{ margin: '18px 0' }}>
      <label className="label" htmlFor={id}>{label} — <output htmlFor={id}>{display}</output></label>
      <input
        id={id} type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#B91C1C', height: 44 }}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between' }} className="small"><span>{minLabel}</span><span>{maxLabel}</span></div>
      {hint ? <p id={`${id}-hint`} className="small">{hint}</p> : null}
    </div>
  );
}

export default function HostSetupForm({ value, onChange, showPresets = true }: {
  value: HostSetupDraft;
  onChange: (d: HostSetupDraft) => void;
  showPresets?: boolean;
}) {
  const [preset, setPreset] = useState<'quick' | 'standard' | 'big-park' | 'custom'>('custom');
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

  const hunters = effectiveHunterCount(value);
  const runners = value.maxPlayers - hunters;
  const suggested = suggestedRadiusFor(value);
  const radiusSteps: number[] = [];
  // Unbounded in practice: the list always runs at least 500 m
  // past the current radius, so the + stepper never dead-ends at
  // the slider's convenience range (10 km) — the host can set any
  // radius (founder decision, 2026-11-17, unlimited past 1 km).
  const radiusStepsTop = Math.max(RADIUS_BOUNDS.max, value.radiusMeters + 500);
  for (let r = RADIUS_BOUNDS.min; r <= radiusStepsTop; r += RADIUS_BOUNDS.step) radiusSteps.push(r);
  const playerSteps: number[] = [];
  for (let n = 3; n <= 30; n++) playerSteps.push(n);
  const hunterSteps: number[] = [];
  for (let n = 1; n <= value.maxPlayers - 1; n++) hunterSteps.push(n);

  /** Picking a mode applies it at once. */
  const changeMode = (m: MatchMode) => {
    setPreset('custom');
    onChange({ ...value, mode: m });
  };
  const applyBuiltIn = (id: BuiltInPresetId) => {
    const b = BUILT_INS[id];
    setPreset(id);
    onChange({
      ...value, ...b.rules, maxPlayers: value.maxPlayers,
      hunterCount: Math.min(b.rules.hunterCount, value.maxPlayers - 1),
      radiusMeters: b.radiusMeters,
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
        catchConfirmationRequired: value.catchConfirmationRequired,
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

      <Section title="Mode">
        <div style={cardStyle(true)} aria-label="Manhunt mode selected">
          <strong style={{ fontSize: 17 }}>Manhunt</strong>
          <span className="small" style={{ display: 'block' }}>Hunters chase, Runners survive.</span>
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
        </div>
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
      </Section>

      <Section title="Play area">
        <ToggleRow
          label="Play zone"
          hint={value.playZoneEnabled
            ? 'On — the game has a bounded play zone and scheduled pings.'
            : 'Off — classic hide and seek: no zone, no pings. Hunters find Runners by looking, not by a boundary or a ping.'}
          checked={value.playZoneEnabled ?? true}
          onChange={(v) => update(v
            ? { playZoneEnabled: true }
            : { playZoneEnabled: false, pingIntervalSeconds: 0, zoneShrinkEnabled: false })}
        />
        {value.playZoneEnabled ? (
          <>
            <p style={{ marginTop: 0 }}>Start from where you are standing. The zone is drawn on a real map — no place name to type. Your GPS sets the centre, and the size is suggested from your player count.</p>
            <fieldset style={{ border: 0, padding: 0, margin: '12px 0 4px' }}>
              <legend><strong>Zone shape</strong></legend>
              <label style={cardStyle(value.zoneShape === 'circle')}>
                <input type="radio" name="zone-shape" checked={value.zoneShape === 'circle'} onChange={() => update({ zoneShape: 'circle', drawnBoundary: null })} style={{ marginRight: 8, width: 20, height: 20, accentColor: '#B91C1C' }} />
                <strong>Circle</strong> — a circle around your location. Size it with the stepper or slider below.
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
                <strong>Draw</strong> — a custom shape on the map. Drag the corners to shape it, drag the middle to move the whole zone.
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
                  label="Corners" hint="How many corners the drawn shape has. Changing this redraws the shape as a regular polygon around the centre — drag the corners after to shape it again."
                  steps={CORNER_STEPS} value={value.drawnBoundary?.length ?? DRAW_DEFAULT_CORNERS} display={`${value.drawnBoundary?.length ?? DRAW_DEFAULT_CORNERS} corners`}
                  onChange={(v) => { const b = drawnBoundaryFor(value, v); if (b) update({ drawnBoundary: b }); }}
                />
                <p><strong>Size across:</strong> {value.drawnBoundary ? `about ${formatDistance(zoneDiameterMeters(value.drawnBoundary))} across` : 'not drawn yet'} · drag a corner to change the shape, drag the middle to move the whole zone.</p>
              </>
            ) : null}
            <StepperRow
              label="Radius" hint={value.zoneShape === 'draw' ? 'Scales the whole drawn shape — the size across follows this radius.' : 'Centred on your current location. The circle scales on the map as you change it.'}
              steps={radiusSteps} value={value.radiusMeters} display={formatDistance(value.radiusMeters)}
              onChange={(v) => {
                if (value.zoneShape === 'draw' && value.drawnBoundary) update({ radiusMeters: v, drawnBoundary: scaleDrawnToDiameter(value.drawnBoundary, v * 2) });
                else update({ radiusMeters: v });
                setFitSignal((s) => s + 1);
              }}
            />
            <SliderRow
              id="zone-radius" label="Zone size" display={value.zoneShape === 'draw' && value.drawnBoundary ? `about ${formatDistance(zoneDiameterMeters(value.drawnBoundary))} across` : `about ${formatDistance(value.radiusMeters * 2)} across`}
              min={RADIUS_BOUNDS.min} max={Math.max(RADIUS_BOUNDS.max, value.radiusMeters)} step={RADIUS_BOUNDS.step} value={value.radiusMeters}
              onChange={(v) => {
                if (value.zoneShape === 'draw' && value.drawnBoundary) update({ radiusMeters: v, drawnBoundary: scaleDrawnToDiameter(value.drawnBoundary, v * 2) });
                else update({ radiusMeters: v });
                setFitSignal((s) => s + 1);
              }}
              minLabel="200 m across" maxLabel="10 km across (slider range — no maximum)"
              hint={`Radius ${formatDistance(value.radiusMeters)} — about ${formatDistance(value.radiusMeters * 2)} across. Suggested for ${value.maxPlayers} players: about ${formatDistance(suggested * 2)} across. The suggestion is a starting point, not a measured value — sizes are calibration open, so check the shape against the real ground. Radius at least 100 m, no maximum — set any size past 1 km.`}
            />
            <p>
              <button type="button" className="btn btn-secondary" onClick={() => {
                if (value.zoneShape === 'draw' && value.drawnBoundary) update({ radiusMeters: suggested, drawnBoundary: scaleDrawnToDiameter(value.drawnBoundary, suggested * 2) });
                else update({ radiusMeters: suggested });
                setFitSignal((s) => s + 1);
              }}>Reset to suggested size</button>
            </p>
          </>
        ) : (
          <p className="small">No play zone in this game — and no pings. Hunters find Runners by looking. The outside-zone rule, the shrink rule and the zone map do not apply. Turn the play zone back on to use them.</p>
        )}
      </Section>

      <Section title="Players">
        <StepperRow
          label="Expected players" hint="How many players the game is sized for (3–30). The zone suggestion follows this number."
          steps={playerSteps} value={value.maxPlayers} display={`${value.maxPlayers} players`}
          onChange={(v) => update({ maxPlayers: v, hunterCount: Math.min(value.hunterCount, v - 1), radiusMeters: value.radiusMeters })}
        />
        <ToggleRow
          label="Balance hunters"
          hint={value.balanceHunters
            ? `Set from the roster when the match starts — ${effectiveHunterCount(value)} Hunter${effectiveHunterCount(value) === 1 ? '' : 's'} for ${value.maxPlayers} players (table: 1 for 3–4, 2 for 5–8, 3 for 9–16, 4 for 17–24, 5 for 25–30 — calibration open).`
            : 'Off — use the Hunters stepper below instead of the table.'}
          checked={value.balanceHunters ?? false}
          onChange={(v) => update({ balanceHunters: v })}
        />
        {value.balanceHunters ? (
          <p className="small">Balance is on: {hunters} Hunter{hunters === 1 ? '' : 's'} · {runners} Runner{runners === 1 ? '' : 's'} for {value.maxPlayers} players. The final count is set from the players who actually joined, when the match starts.</p>
        ) : (
          <StepperRow
            label="Hunters" hint="How many Hunters the match starts with."
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
          label="Head start" hint="Time Runners get before Hunters are released. Hunters see no Runner locations during the head start."
          steps={HEAD_START_STEPS_S} value={value.headStartSeconds} display={formatSecondsShort(value.headStartSeconds)}
          onChange={(v) => update({ headStartSeconds: v })}
        />
        <StepperRow
          label="Location ping" hint={value.playZoneEnabled ? 'How often Hunters see where Runners were — a coarse area, never an exact pin. None means no pings at all.' : 'No pings — the play zone is off, so there is nothing to ping from. Turn the play zone on to use pings.'}
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
        <ToggleRow
          label="Runner confirms every catch (recommended)"
          hint="On: a catch counts only when the Runner confirms it on their own phone. Off: a Hunter’s tag counts at once. A Runner can always dispute a catch — that is never turned off. GPS is supporting evidence only, never proof."
          checked={value.catchConfirmationRequired}
          onChange={(v) => update({ catchConfirmationRequired: v })}
        />
        <p><strong>Outside the zone:</strong> if a player leaves the play zone, a 30-second countdown appears on their screen. Get back inside before it ends, or they are ejected from the game. This is a fixed rule, not a setting — there is nothing to adjust here.</p>
      </Section>

      {showPresets ? (
        <Section title="House-rule presets">
          <p className="small" style={{ marginTop: 0 }}>Save these settings under a name and reuse them next time. Presets live on this device only. Everything is free — no payment, no membership.</p>
          {(Object.keys(BUILT_INS) as BuiltInPresetId[]).map((k) => (
            <label key={k} style={cardStyle(preset === k)}>
              <input type="radio" name="preset" checked={preset === k} onChange={() => applyBuiltIn(k)} style={{ marginRight: 8, width: 20, height: 20, accentColor: '#B91C1C' }} />
              <strong>{BUILT_INS[k].label}</strong> — {formatMinutes(BUILT_INS[k].rules.durationSeconds / 60)}, {BUILT_INS[k].rules.hunterCount} Hunter{BUILT_INS[k].rules.hunterCount === 1 ? '' : 's'}
              <span className="small" style={{ display: 'block' }}>{BUILT_INS[k].blurb}</span>
            </label>
          ))}
          <p><strong>Your saved presets</strong></p>
          {savedPresets.length === 0 ? <p className="small">No saved presets yet. Set the rules above, name them, and save — then reuse them for the next game.</p> : (
            <ul>
              {savedPresets.map((p) => (
                <li key={p.presetId}>
                  <strong>{p.name}</strong> — {describeMode(p.rules.mode).label}, {formatMinutes(p.rules.durationSeconds / 60)}, {p.rules.hunterCount} Hunter{p.rules.hunterCount === 1 ? '' : 's'}, ping {formatPing(p.rules.pingIntervalSeconds)}
                  {' '}<button type="button" className="btn btn-secondary" onClick={() => { onChange(applyPresetToDraft(value, p)); setPresetNote(`Loaded “${p.name}”.`); }}>Load</button>
                  {' '}<button type="button" className="btn btn-secondary" onClick={() => deletePreset(p.presetId)}>Delete</button>
                </li>
              ))}
            </ul>
          )}
          <label className="label" htmlFor="preset-name">Save the current settings as a preset</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input id="preset-name" className="input" value={presetName} onChange={(e) => setPresetName(e.target.value)} maxLength={40} placeholder="e.g. Sunday park game" style={{ flex: '1 1 200px', minWidth: 0, margin: 0 }} />
            <button type="button" className="btn btn-secondary" onClick={savePreset}>Save preset</button>
          </div>
          {presetNote ? <p role="status" className="small">{presetNote}</p> : null}
        </Section>
      ) : null}

      <p className="small">
        Privacy: Hunters see Runners only as scheduled coarse ping areas — never exact pins. Locations are deleted at match end. Play is foreground-only: keep the app open and your screen on.
      </p>
    </div>
  );
}
