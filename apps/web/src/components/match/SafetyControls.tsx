'use client';
import { SOS_COPY } from '@pakdam/engine';
/** Safety bar — always visible, never obscured (24 S05). SOS is alert red
 *  with white text (4.83:1). The bar is sticky at the bottom of the play
 *  screen. "I'm safe" is a Runner check-in, separate from SOS: it tells
 *  the host you are OK without raising an alarm. SOS asks once to confirm
 *  (it shares your position with the host and pauses the match), so a
 *  pocket tap cannot fire it by accident. */
export default function SafetyControls({
  onPause, onSos, onLeave, paused, onSafe,
}: {
  onPause: () => void; onSos: () => void; onLeave: () => void; paused: boolean; onSafe?: () => void;
}) {
  return (
    <div>
      <div className="safety" role="group" aria-label="Safety controls — always visible">
        <button type="button" onClick={onPause} aria-label="Safety pause — pauses the match for everyone" style={{ minHeight: 52 }}>{paused ? '▶ Resume game' : '❚❚ Safety pause'}</button>
        <button type="button" className="danger" aria-label="SOS — shares your position with the host" style={{ minHeight: 52 }} onClick={() => { if (window.confirm(SOS_COPY)) onSos(); }}>SOS</button>
        {onSafe ? <button type="button" onClick={onSafe} aria-label="I'm safe — check in with the host" style={{ minHeight: 52 }}>✓ I’m safe</button> : null}
        <button type="button" onClick={onLeave} aria-label="Leave game — stops sharing your location" style={{ minHeight: 52 }}>Leave / Stop sharing</button>
      </div>
      <p className="small">Safety pause, SOS, “I’m safe” and Leave work only while this app is open and your screen is on. {SOS_COPY} <a href="/help">Get help — safety rules, report a problem, or file a grievance</a>.</p>
    </div>
  );
}
