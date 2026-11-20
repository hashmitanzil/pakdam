'use client';

/**
 * HostSettingsSheet — settings re-edit sheet (ShadowHunt's sheet is the
 * model: same controls as setup, no map, DONE).
 *
 * Opened from the lobby's SETTINGS button. Mode + rules + teams — the
 * full game customisation after the lobby exists. No map and no zone
 * controls here; the zone is edited on the create screen.
 */
import type { RoomConfig } from '@pakdam/shared';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import { RulesControls, TeamControls } from '../host-setup/SetupControls';

export interface HostSettingsSheetProps {
  open: boolean;
  config: RoomConfig;
  activePlayerCount: number;
  onChange: (config: RoomConfig) => void;
  onClose: () => void;
}

export function HostSettingsSheet({
  open,
  config,
  activePlayerCount,
  onChange,
  onClose,
}: HostSettingsSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Settings">
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
          <button
            type="button"
            onClick={() => {
              onChange({
                ...config,
                mode: config.mode === 'classic' ? 'infection' : 'classic',
              });
            }}
            className="shrink-0 text-[15px] font-semibold text-[#EF4444]"
          >
            Change
          </button>
        </div>
      </section>
      <RulesControls config={config} activePlayerCount={activePlayerCount} isHost onChange={onChange} />
      <TeamControls config={config} activePlayerCount={activePlayerCount} isHost onChange={onChange} />
      <div className="mt-6">
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Sheet>
  );
}
