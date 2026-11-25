'use client';

/**
 * OnboardingCards (Scope C item 1) — the rules before the first game.
 *
 * 3 short cards (zone / hidden / squeeze) + a final "Your turn" card,
 * plain words, skippable from any card. Progress dashes at the top.
 * The final card offers Host a game / Join with a code — the same
 * doors as home. Closing (Skip, Got it, or either final-card door)
 * marks the cards seen, so they never auto-show again; "How to play"
 * on home re-opens them.
 */
import { useState } from 'react';
import { ONBOARDING_CARDS, markOnboardingSeen } from '../lib/onboarding';
import { Button } from './ui/Button';

export interface OnboardingCardsProps {
  onClose: () => void;
  onHost: () => void;
  onJoin: () => void;
}

export function OnboardingCards({ onClose, onHost, onJoin }: OnboardingCardsProps) {
  const [index, setIndex] = useState(0);
  const card = ONBOARDING_CARDS[index] ?? ONBOARDING_CARDS[0]!;
  const isLast = index === ONBOARDING_CARDS.length - 1;

  const finish = (): void => {
    markOnboardingSeen();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 px-4 pb-6 sm:items-center"
      role="dialog"
      aria-label="How Pakdam works"
    >
      <div className="w-full max-w-[560px] rounded-[20px] border border-[#26262B] bg-[#141416] p-5">
        <div className="flex items-center justify-between">
          <div className="flex gap-1.5" aria-label={`Card ${index + 1} of ${ONBOARDING_CARDS.length}`}>
            {ONBOARDING_CARDS.map((c, i) => (
              <span
                key={c.kicker}
                aria-hidden
                className={`h-1.5 w-8 rounded-full ${i <= index ? 'bg-[#EF4444]' : 'bg-[#26262B]'}`}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={finish}
            className="text-[15px] font-semibold text-[#A1A1AA]"
          >
            Skip
          </button>
        </div>

        <p className="pakdam-label mt-5">{card.kicker}</p>
        <h2 className="mt-2 text-[28px] font-bold leading-tight text-white">{card.title}</h2>
        <p className="mt-2 text-[16px] leading-snug text-[#A1A1AA]">{card.body}</p>

        {isLast ? (
          <div className="mt-6 flex flex-col gap-3">
            <Button
              variant="primary"
              onClick={() => {
                finish();
                onHost();
              }}
            >
              Host a game
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                finish();
                onJoin();
              }}
            >
              Join with a code
            </Button>
            <button
              type="button"
              onClick={finish}
              className="self-center text-[15px] font-semibold text-[#A1A1AA]"
            >
              Got it — take me home
            </button>
          </div>
        ) : (
          <div className="mt-6">
            <Button variant="primary" onClick={() => setIndex((i) => i + 1)}>
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
