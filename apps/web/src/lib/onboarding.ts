/**
 * Onboarding cards (Scope C item 1) — the three rules, in Pakdam's own
 * words, plus the final "Your turn" card. Shown on home before the
 * first game; skippable; re-openable from "How to play" on home.
 *
 * Copy is Pakdam's own — not SCRAM's text. Every claim here is a
 * settled Pakdam rule: the zone is drawn by the host and leaving it
 * starts the 30 s return countdown (then ejection); runners stay
 * hidden and hunters only see pings on the host's interval; the zone
 * loses a quarter of its radius each shrink.
 */
export interface OnboardingCard {
  /** Short kicker, e.g. "THE ZONE". */
  kicker: string;
  title: string;
  body: string;
}

export const ONBOARDING_CARDS: OnboardingCard[] = [
  {
    kicker: 'THE ZONE',
    title: 'Stay inside the zone',
    body: 'The host draws a zone on the map. Everyone plays inside it — step outside and you have 30 seconds to get back, or you\u2019re out.',
  },
  {
    kicker: 'HIDDEN',
    title: 'Hunters can\u2019t see you live',
    body: 'Runners stay hidden on the hunters\u2019 map. Hunters only see where you are when a ping goes out — the host sets how often.',
  },
  {
    kicker: 'THE SQUEEZE',
    title: 'The zone keeps shrinking',
    body: 'During the game the zone loses a quarter of its size each time it shrinks. Keep moving inward, or you\u2019ll be caught outside it.',
  },
  {
    kicker: 'YOUR TURN',
    title: 'Your turn',
    body: 'Get 2 or more friends together. One of you hosts, everyone else joins free with the room code. No account, no payment.',
  },
];

const SEEN_KEY = 'pakdam.onboarding.seen.v1';

/** True once the player has finished or skipped the cards once. */
export function hasSeenOnboarding(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Record that the cards were finished or skipped — they stop auto-showing. */
export function markOnboardingSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Storage is best-effort — the cards just show again next visit.
  }
}
