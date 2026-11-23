/**
 * QR scan-loop caps — performance roadmap R4 (P0).
 *
 * After ~5 s without a decode the scanner escalates; the escalation
 * used to decode every frame at full camera resolution with no time
 * cap, saturating the main thread on the catch page (its own 1 s
 * QR-countdown ticker, socket handling and the Tag tap all share that
 * thread). Caps:
 * - Escalated width capped at 1280 px (a 220 px QR decodes comfortably
 *   at that size; full-res stays available only as a single-shot
 *   retry, not per-frame).
 * - The every-3rd-frame cadence is KEPT when escalated (≤ ~10 decode
 *   attempts/s at 30 fps capture, never every frame).
 * - The loop stops after ~18 s without a decode with a "move closer /
 *   tap to retry" state, and stops decoding after a successful scan —
 *   the "Scan again" button restarts it. A wrong scan is re-scanned
 *   via "Scan again", not by leaving the loop running.
 */
export const QR_SCAN_ESCALATE_AFTER_MS = 5_000;
export const QR_SCAN_BASE_WIDTH_PX = 640;
export const QR_SCAN_ESCALATED_WIDTH_PX = 1280;
export const QR_SCAN_STOP_AFTER_MS = 18_000;
/** Decode every Nth frame, escalated or not. */
export const QR_SCAN_FRAME_CADENCE = 3;

/** Decode dimensions for one frame: base 640 px, escalated capped at 1280 px. */
export function qrScanDimensions(
  videoWidth: number,
  videoHeight: number,
  escalated: boolean,
): { width: number; height: number } {
  const cap = escalated ? QR_SCAN_ESCALATED_WIDTH_PX : QR_SCAN_BASE_WIDTH_PX;
  const scale = Math.min(1, cap / Math.max(1, videoWidth));
  return {
    width: Math.max(1, Math.round(videoWidth * scale)),
    height: Math.max(1, Math.round(videoHeight * scale)),
  };
}

/** True when this frame is a decode frame (every 3rd, escalated or not). */
export function qrScanIsDecodeFrame(frame: number): boolean {
  return frame % QR_SCAN_FRAME_CADENCE === 0;
}

/** True when the loop must stop without a decode (~18 s elapsed). */
export function qrScanShouldStop(elapsedMs: number, decoded: boolean): boolean {
  return !decoded && elapsedMs >= QR_SCAN_STOP_AFTER_MS;
}
