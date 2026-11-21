/**
 * cues.ts — haptics + audio cues for the play screen.
 *
 * Vibration is Android-only by feature detection: `navigator.vibrate`
 * exists on Android browsers and is absent where vibration is not
 * supported, so this module never attempts vibration on a device that
 * cannot do it, and never claims otherwise. Devices without vibration
 * get sound cues only (when cue sounds are enabled).
 *
 * Audio is optional and OFF by default. Beeps come from a lazily
 * created Web Audio context, resumed on the first user tap (the
 * autoplay policy blocks audio created before a gesture), so call
 * `unlockCueAudio()` from a tap handler.
 */

export interface CueSettings {
  /** Vibration on/off (Android only — no-ops silently elsewhere). */
  hapticsEnabled: boolean;
  /** Short tones on/off. Off by default; separate from voice-radio mute. */
  soundsEnabled: boolean;
}

export const DEFAULT_CUE_SETTINGS: CueSettings = {
  hapticsEnabled: true,
  soundsEnabled: false,
};

/** True only where the platform actually offers vibration (Android). */
export function isVibrationSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.vibrate === 'function'
  );
}

function vibrate(pattern: number | number[], settings: CueSettings): void {
  if (!settings.hapticsEnabled) return;
  if (!isVibrationSupported()) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Vibration is best-effort — never let it break the game.
  }
}

/** Short buzz on ping received. */
export function cuePingReceived(settings: CueSettings): void {
  vibrate(40, settings);
}

/** Long buzz on zone warning (outside-zone entry / ≤ 10 s left). */
export function cueZoneWarning(settings: CueSettings): void {
  vibrate(300, settings);
}

/** Double-buzz on tag. */
export function cueTag(settings: CueSettings): void {
  vibrate([80, 80, 80], settings);
}

// --- Audio (optional, off by default) -------------------------------------

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  if (!audioContext) {
    try {
      audioContext = new Ctor();
    } catch {
      return null;
    }
  }
  return audioContext;
}

/**
 * Resume (and lazily create) the audio context. Call from a user
 * gesture — a tap on a toggle or anywhere on the play screen — so the
 * first cue tone is not blocked by the autoplay policy.
 */
export function unlockCueAudio(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().catch(() => undefined);
  }
}

function beep(
  frequencyHz: number,
  durationMs: number,
  settings: CueSettings,
  delayMs = 0,
): void {
  if (!settings.soundsEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  // The tone itself lives in `play`, so a suspended context can resume
  // first — F9: the old code kicked off resume() and RETURNED, silently
  // dropping the first cue after sounds were enabled.
  const play = (): void => {
    try {
      const startAt = ctx.currentTime + delayMs / 1000;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequencyHz;
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.25, startAt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationMs / 1000);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + durationMs / 1000 + 0.05);
    } catch {
      // Audio is best-effort — never let it break the game.
    }
  };
  if (ctx.state === 'suspended') {
    void ctx.resume().then(play).catch(() => undefined);
    return;
  }
  play();
}

/** Distinct tones per cue kind. Runner ping: high; Hunter ping: low. */
export function cuePingTone(
  kind: 'runner' | 'hunter',
  settings: CueSettings,
): void {
  beep(kind === 'runner' ? 880 : 440, 120, settings);
}

/** Zone shrink / warning tone. */
export function cueZoneTone(settings: CueSettings): void {
  beep(330, 250, settings);
}

/** Tag tone: two rising notes. */
export function cueTagTone(settings: CueSettings): void {
  beep(523, 120, settings);
  beep(784, 180, settings, 140);
}
