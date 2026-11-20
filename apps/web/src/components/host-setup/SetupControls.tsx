/**
 * SetupControls — the lobby-is-setup controls (SCRAM-SPEC §5d + §5f),
 * shared by the lobby page and the HostSettingsSheet (same controls, no
 * map). Every decided setting stays, as one stepper / toggle
 * with at most one short hint. No presets, no extra blocks.
 * All number settings are ShadowHunt-style − / + steppers — no sliders.
 */
import type { ReactNode } from 'react';
import {
  SHRINK_INTERVAL_MINUTES_GRID,
  balancedHunterCount,
  shrinkIntervalForDurationSeconds,
  type RoomConfig,
} from '@pakdam/shared';
import { Stepper } from '../ui/Stepper';
import { Toggle } from '../ui/Toggle';
import { formatDurationShort } from '../../lib/utils';

export interface SetupControlsProps {
  config: RoomConfig;
  /** Active (joined, not left) player count — bounds the Hunters stepper. */
  activePlayerCount: number;
  isHost: boolean;
  onChange: (config: RoomConfig) => void;
}

const DURATION_STEPS = [600, 900, 1200, 1800, 2700, 3600] as const;
const HEAD_START_STEPS = [0, 60, 120, 180, 300] as const;
const PING_STEPS = [0, 30, 60, 120, 180, 300] as const;
/** Shrink-interval grid (minutes) — the canonical grid from @pakdam/shared. */
const SHRINK_STEPS = SHRINK_INTERVAL_MINUTES_GRID;

function row(label: string, value: string, control: ReactNode, hint?: string) {
  return (
    <div className="mt-4 first:mt-0">
      <div className="flex items-baseline justify-between">
        <span className="pakdam-label">{label}</span>
        <span className="text-[17px] font-bold text-white pakdam-numeric">{value}</span>
      </div>
      <div className="mt-1">{control}</div>
      {hint ? <p className="mt-1 text-[13px] text-[#A1A1AA]">{hint}</p> : null}
    </div>
  );
}

/** Rules steppers + shrink + play-zone toggle (SCRAM-SPEC §5d–§5e). */
export function RulesControls({ config, isHost, onChange }: SetupControlsProps) {
  const set = (patch: Partial<RoomConfig>): void => onChange({ ...config, ...patch });
  const pingsOff = config.pingIntervalSeconds === 0;
  const zoneOff = config.playZoneEnabled === false;
  return (
    <section aria-label="Rules">
      {row(
        'Round length',
        formatDurationShort(config.durationSeconds),
        <Stepper
          steps={DURATION_STEPS}
          value={config.durationSeconds}
          label="Round length"
          disabled={!isHost}
          format={(v) => formatDurationShort(v)}
          onChange={(v) =>
            set({
              durationSeconds: v,
              // Shrink time follows the round length (3 shrinks per game):
              // changing the round re-derives the shrink interval, so a
              // short game shrinks faster and a long game slower.
              zoneShrinkIntervalSeconds: shrinkIntervalForDurationSeconds(v),
            })
          }
        />,
        'Runners win if they last this long. The shrink time follows it — 3 shrinks per game.',
      )}
      {row(
        'Head start',
        config.headStartSeconds === 0 ? 'None' : formatDurationShort(config.headStartSeconds),
        <Stepper
          steps={HEAD_START_STEPS}
          value={config.headStartSeconds}
          label="Head start"
          disabled={!isHost}
          format={(v) => (v === 0 ? 'None' : formatDurationShort(v))}
          onChange={(v) => set({ headStartSeconds: v })}
        />,
        'Time runners get before hunters are released.',
      )}
      {row(
        'Pings every',
        zoneOff || pingsOff ? 'Off' : formatDurationShort(config.pingIntervalSeconds),
        <Stepper
          steps={PING_STEPS}
          value={zoneOff ? 0 : config.pingIntervalSeconds}
          label="Pings every"
          disabled={!isHost || zoneOff}
          format={(v) => (v === 0 ? 'Off' : v < 60 ? `${v} s` : formatDurationShort(v))}
          onChange={(v) => set({ pingIntervalSeconds: v })}
        />,
        zoneOff || pingsOff
          ? 'No pings. Neither side sees the other — hunters get no locations at all, including for runners who leave the zone (no code emits a reveal on zone exit).'
          : 'How often both sides see where the other team is.',
      )}
      <div className="mt-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-[15px] font-semibold text-white">Zone shrinks</p>
          <p className="text-[13px] text-[#A1A1AA]">
            The play area loses a quarter of its radius each time.
          </p>
        </div>
        <Toggle
          label="Zone shrinks"
          checked={config.zoneShrinkEnabled}
          disabled={!isHost}
          onChange={(v) => set({ zoneShrinkEnabled: v })}
        />
      </div>
      {config.zoneShrinkEnabled
        ? row(
            'Shrinks every',
            formatDurationShort(config.zoneShrinkIntervalSeconds),
            <Stepper
              label="Shrinks every"
              value={config.zoneShrinkIntervalSeconds / 60}
              steps={SHRINK_STEPS}
              min={1}
              max={20}
              disabled={!isHost}
              format={(v) => formatDurationShort(v * 60)}
              onChange={(v) => set({ zoneShrinkIntervalSeconds: v * 60 })}
            />,
            'Auto from the round length — 3 shrinks per game. You can still change it below.',
          )
        : null}
      <div className="mt-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-[15px] font-semibold text-white">Play zone</p>
          {zoneOff ? (
            <p className="text-[13px] text-[#A1A1AA]">
              No zone and no pings. Classic hide and seek — hunters get no locations at all.
            </p>
          ) : null}
        </div>
        <Toggle
          label="Play zone"
          checked={!zoneOff}
          disabled={!isHost}
          onChange={(v) => set({ playZoneEnabled: v })}
        />
      </div>
    </section>
  );
}

/** Team toggles — host-controlled teams only (SCRAM-SPEC §1, §5f). */
export function TeamControls({
  config,
  activePlayerCount,
  isHost,
  onChange,
}: SetupControlsProps) {
  const set = (patch: Partial<RoomConfig>): void => onChange({ ...config, ...patch });
  const balance = config.balanceHunters !== false;
  const random = config.randomDraw !== false;
  // The stepper cap is the ROOM capacity (maxPlayers − 1), never the
  // current roster. The host sets the count during setup, before players
  // join — capping by the roster pinned it to 1 while the host was alone
  // (the default hunterCount is 2, so + was dead and it could only go
  // down). The roster constraint is enforced at START, not during setup:
  // the start gate blocks with a plain-words reason when the count would
  // leave no Runner.
  const maxHunters = Math.max(1, config.maxPlayers - 1);
  return (
    <section aria-label="Players">
      <div className="mt-4 flex items-center justify-between gap-3 first:mt-0">
        <div>
          <p className="text-[15px] font-semibold text-white">Balance hunters</p>
          <p className="text-[13px] text-[#A1A1AA]">
            {balance
              ? 'Set from the roster when the match starts — 2 for 6 players, 3 for 16.'
              : 'You choose the number yourself, below.'}
          </p>
        </div>
        <Toggle
          label="Balance hunters"
          checked={balance}
          disabled={!isHost}
          onChange={(v) => set({ balanceHunters: v })}
        />
      </div>
      {balance
        ? // Balance ON: the stepper is hidden (it would be silently
          // discarded — the table decides the draw), but the effective
          // count is shown so the host sees what will actually be drawn.
          row(
            'Hunters',
            String(balancedHunterCount(Math.max(3, activePlayerCount))),
            <p className="text-[13px] text-[#A1A1AA]">
              Set by balance for {activePlayerCount} player{activePlayerCount === 1 ? '' : 's'}.
              Turn balance off to choose yourself.
            </p>,
          )
        : row(
            'Hunters',
            String(config.hunterCount),
            <Stepper
              label="Hunters"
              value={config.hunterCount}
              step={1}
              min={1}
              max={maxHunters}
              disabled={!isHost}
              format={(v) => String(v)}
              onChange={(v) => set({ hunterCount: Math.max(1, Math.min(maxHunters, v)) })}
            />,
          )}
      <div className="mt-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-[15px] font-semibold text-white">Random hunters</p>
          <p className="text-[13px] text-[#A1A1AA]">
            {random
              ? 'Hunters are drawn at random when the match starts.'
              : 'Tap players in the roster to pick the Hunters.'}
          </p>
        </div>
        <Toggle
          label="Random hunters"
          checked={random}
          disabled={!isHost}
          onChange={(v) =>
            set({
              randomDraw: v,
              teamAssignment: v ? 'random' : 'selected',
            })
          }
        />
      </div>
      {/*
        No "Show ping history" toggle here on purpose: the underlying
        history was never implemented, so the toggle had zero effect and
        a visible control must never promise a feature that does not
        exist (P1-26). The `showPingHistory` config field itself is
        removed from the shared types on the server side.
      */}
    </section>
  );
}
