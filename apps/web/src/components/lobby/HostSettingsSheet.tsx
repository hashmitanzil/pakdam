'use client';

/**
 * HostSettingsSheet — settings re-edit sheet (ShadowHunt's sheet is the
 * model: same controls as setup, no map, DONE).
 *
 * The lobby page itself IS the settings screen; this sheet is the
 * compact re-edit path from the code card's SETTINGS button. Same
 * Rules + Team controls as the lobby, no map, no zone editor here —
 * the zone size row inside the sheet opens the full-screen editor
 * (the sheet closes first; the editor sits above it).
 */
import type { RoomConfig } from '@pakdam/shared';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import { RulesControls, TeamControls } from '../host-setup/SetupControls';
import { formatZoneSize } from '../../lib/utils';
import { boundaryRadiusMeters, finalRadiusFromPercent } from '../host-setup/drawPoints';

export interface HostSettingsSheetProps {
  open: boolean;
  config: RoomConfig;
  activePlayerCount: number;
  onChange: (config: RoomConfig) => void;
  onClose: () => void;
  onOpenZoneEditor: () => void;
}

export function HostSettingsSheet({
  open,
  config,
  activePlayerCount,
  onChange,
  onClose,
  onOpenZoneEditor,
}: HostSettingsSheetProps) {
  const radius = boundaryRadiusMeters(config.zone.boundary);
  const finalRadius = finalRadiusFromPercent(radius, config.finalSizePercent ?? null);
  return (
    <Sheet open={open} onClose={onClose} title="Settings">
      <RulesControls config={config} activePlayerCount={activePlayerCount} isHost onChange={onChange} />
      <button
        type="button"
        onClick={() => {
          onClose();
          onOpenZoneEditor();
        }}
        className="mt-4 flex w-full items-center justify-between rounded-[16px] border border-[#26262B] bg-[#1E1E22] px-4 py-3 text-left"
      >
        <span>
          <span className="pakdam-label block">Zone size</span>{' '}
          <span className="text-[17px] font-bold text-white pakdam-numeric">
            {config.playZoneEnabled === false
              ? 'Off'
              : formatZoneSize(radius, finalRadius)}
          </span>
        </span>
        <span className="text-[18px] text-[#A1A1AA]" aria-hidden>
          ›
        </span>
      </button>
      <TeamControls config={config} activePlayerCount={activePlayerCount} isHost onChange={onChange} />
      <div className="mt-6">
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Sheet>
  );
}
