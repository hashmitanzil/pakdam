'use client';

/**
 * HostSettingsSheet — settings re-edit sheet (ShadowHunt's sheet is the
 * model: same controls as setup, no map, DONE).
 *
 * Opened from the lobby's SETTINGS button and from the settings summary
 * strip. Mode + rules + teams — the full game customisation after the
 * lobby exists. No map and no zone controls here; the zone is edited on
 * the create screen.
 *
 * Read-only mode: a joiner (isHost === false) opens the same sheet to
 * SEE the settings, but every edit control is disabled (the steppers /
 * toggles take `disabled` from isHost, the mode "Change" button is not
 * rendered at all) and onChange is replaced with a no-op, so no config
 * save can fire from this sheet for a joiner. Live mode is also
 * server-guarded (update-config verifies the host token, 403 for a
 * non-host); demo mode has no server, so the client-side guard is what
 * keeps a joiner read-only there.
 */
import type { RoomConfig } from '@pakdam/shared';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import { RulesControls, TeamControls } from '../host-setup/SetupControls';

export interface HostSettingsSheetProps {
  open: boolean;
  config: RoomConfig;
  activePlayerCount: number;
  /** False for a joiner: the sheet opens read-only (see header comment). */
  isHost: boolean;
  onChange: (config: RoomConfig) => void;
  onClose: () => void;
}

export function HostSettingsSheet({
  open,
  config,
  activePlayerCount,
  isHost,
  onChange,
  onClose,
}: HostSettingsSheetProps) {
  // Read-only guard: a joiner's sheet never calls the config-save path,
  // even if a control somehow fired — the host's onChange is swapped
  // for a no-op. (The steppers / toggles are disabled too, and the mode
  // "Change" button below is not rendered for a joiner.)
  const handleChange = isHost ? onChange : () => {};
  return (
    <Sheet open={open} onClose={onClose} title="Settings">
      {!isHost ? (
        <p className="mb-4 text-[13px] text-[#F59E0B]">
          View only — only the host can change settings.
        </p>
      ) : null}
      <section aria-label="Game mode" className="mb-4">
        <p className="pakdam-label">Game mode</p>
        <div className="mt-1 flex items-center justify-between gap-3">
          <div>
            <p className="text-[20px] font-bold text-white">
              {config.mode === 'classic' ? 'Classic' : 'Infection'}
            </p>
            <p className="text-[13px] text-[#A1A1AA]">
              {config.mode === 'classic'
                ? "Tagged? You're out. Watch live."
                : 'Tagged? You join the Hunters.'}
            </p>
          </div>
          {isHost ? (
            <button
              type="button"
              onClick={() => {
                handleChange({
                  ...config,
                  mode: config.mode === 'classic' ? 'infection' : 'classic',
                });
              }}
              className="shrink-0 text-[15px] font-semibold text-[#EF4444]"
            >
              Change
            </button>
          ) : null}
        </div>
      </section>
      <RulesControls config={config} activePlayerCount={activePlayerCount} isHost={isHost} onChange={handleChange} />
      <TeamControls config={config} activePlayerCount={activePlayerCount} isHost={isHost} onChange={handleChange} />
      <div className="mt-6">
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Sheet>
  );
}
