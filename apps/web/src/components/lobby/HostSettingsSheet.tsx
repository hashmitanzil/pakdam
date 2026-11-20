'use client';

/**
 * HostSettingsSheet — settings re-edit sheet (ShadowHunt's sheet is the
 * model: same controls as setup, no map, DONE).
 *
 * The lobby page itself IS the settings screen; this sheet is the
 * compact re-edit path from the code card's SETTINGS button. Same
 * Rules + Team controls as the lobby, no map, no zone controls here —
 * the zone is edited inline on the lobby page itself.
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
