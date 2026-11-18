'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import HostSetupForm from './HostSetupForm';
import { draftFromConfig, draftToConfig, roomSummaryStrip, validateDraft } from './draft';
import type { HostSetupDraft } from './draft';
import type { RoomConfig } from '@pakdam/shared';

/**
 * Lobby settings sheet — the same host-setup controls as the create
 * screen, reopened for the host in the lobby. The host edits, then
 * taps DONE to save (or closes without saving). The sheet validates
 * before DONE enables, exactly like the create screen.
 *
 * Wiring note: the room lobby page mounts this sheet with the room's
 * current config; on DONE it calls updateRoomConfig (local store) with
 * the new config. Settings can only change while the room is in the
 * lobby — never after the match starts.
 */
export default function HostSettingsSheet({ open, config, onDone, onClose }: {
  open: boolean;
  config: RoomConfig;
  onDone: (next: RoomConfig) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<HostSetupDraft>(() => draftFromConfig(config));
  const [error, setError] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  // Closing discards unsaved changes — confirm first when anything
  // changed, on every exit path (backdrop, ✕ button, Escape). A
  // sheet with no changes closes straight away, no questions asked.
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromConfig(config));
  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('Close without saving? Your changes to the game settings will be lost.')) return;
    onClose();
  }, [dirty, onClose]);

  // While the sheet is open: Escape closes it (confirming first when
  // there are unsaved changes) and focus moves into the panel so
  // keyboard users land inside the dialog, not behind it.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, requestClose]);

  if (!open) return null;
  const errors = validateDraft(draft);

  const done = () => {
    const errs = validateDraft(draft);
    if (errs.length) { setError(errs[0] ?? 'Check the settings above.'); return; }
    onDone(draftToConfig(draft, { hostOnSiteConfirmed: config.hostOnSiteConfirmed, selectedHunterIds: config.selectedHunterIds }));
  };

  return (
    <div
      role="dialog" aria-modal="true" aria-label="Game settings"
      style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={requestClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        style={{ background: 'var(--surface)', color: 'var(--ink)', width: '100%', maxWidth: 720, maxHeight: '92vh', overflowY: 'auto', borderRadius: '20px 20px 0 0', padding: '8px 16px calc(16px + env(safe-area-inset-bottom, 0px))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ width: 48, height: 5, borderRadius: 999, background: '#C9B8B8', margin: '8px auto 4px' }} aria-hidden="true" />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h2 style={{ margin: '8px 0' }}>Game settings <span className="small" style={{ background: 'var(--line)', borderRadius: 999, padding: '2px 8px' }}>HOST</span></h2>
          <button type="button" className="btn btn-secondary" onClick={requestClose} aria-label="Close settings">✕ Close</button>
        </div>
        <p className="small" style={{ marginTop: 0 }}>{roomSummaryStrip(draft)}</p>
        <HostSetupForm value={draft} onChange={setDraft} showPresets={false} shrinkAsOwnSection />
        {error ? <p role="alert">{error}</p> : null}
        {errors.length > 0 ? <p role="alert" className="small">{errors[0]}</p> : null}
        <div style={{ position: 'sticky', bottom: 0, background: 'var(--surface)', padding: '12px 0 calc(4px + env(safe-area-inset-bottom, 0px))', borderTop: '1px solid var(--line, #E8CFCF)' }}>
          {/* Never disabled: a disabled Done silently did nothing while
              the host waited, with the reason only in small print
              above. The button always works; done() explains exactly
              what is wrong, or saves. Same rule as CREATE LOBBY. */}
          <button type="button" className="btn btn-lg" style={{ width: '100%' }} onClick={done} aria-disabled={errors.length > 0}>✓ DONE — save settings</button>
          <p className="small" style={{ textAlign: 'center', margin: '8px 0 0' }}>Closing without tapping Done discards your changes.</p>
        </div>
      </div>
    </div>
  );
}
