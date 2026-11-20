'use client';

/**
 * Home (SCRAM-SPEC §3) — headline, hero visual, two actions.
 *
 * HOST A GAME → Mode select (the room is created when a mode card is
 * tapped, with the host's codename). JOIN A GAME → the join screen
 * (/join), where the lobby code AND the codename are entered together.
 * The home page itself takes no code — the code lives only on the join
 * screen (and on invite deep-links, /join/<CODE>).
 *
 * Hero: a pure-CSS radar — concentric rings pulsing out from a red
 * target dot, green runner dots and red hunter dots floating around
 * it, over a breathing red glow and soft depth orbs. No assets, no
 * images, cheap on a phone. Entrance is a staggered fade-and-rise;
 * motion respects prefers-reduced-motion (see globals.css). Below the
 * buttons a short info section says what Pakdam is and how one game
 * works in three one-line cards.
 */
import { useRouter } from 'next/navigation';
import { Button } from '../components/ui/Button';

export default function HomePage() {
  const router = useRouter();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col px-4 pb-6 pt-6">
      <header className="pakdam-anim-rise flex items-center justify-between">
        <span className="pakdam-display text-[22px] text-white">Pakdam</span>
      </header>

      {/* Hero visual: radar rings + floating runner/hunter dots, layered
          for depth — a green glow low-left and a red glow high-right sit
          behind the radar so the scene reads 3D, not flat. */}
      <div
        className="relative mt-6 flex h-44 items-center justify-center overflow-hidden"
        aria-hidden
      >
        {/* Depth orbs: soft colour glows at different depths. */}
        <span className="absolute -left-6 bottom-0 h-24 w-24 rounded-full bg-[#22C55E]/15 blur-2xl" />
        <span className="absolute -right-4 top-0 h-28 w-28 rounded-full bg-[#EF4444]/20 blur-2xl" />
        {/* Breathing red glow behind the target. */}
        <span className="pakdam-anim-glow absolute h-40 w-40 rounded-full bg-[#EF4444]/25 blur-2xl" />
        {/* Radar rings, staggered so they ripple outward in turn. */}
        <span className="pakdam-anim-ring absolute h-40 w-40 rounded-full border border-[#EF4444]/50" />
        <span
          className="pakdam-anim-ring absolute h-40 w-40 rounded-full border border-[#EF4444]/40"
          style={{ animationDelay: '0.9s' }}
        />
        <span
          className="pakdam-anim-ring absolute h-40 w-40 rounded-full border border-[#EF4444]/30"
          style={{ animationDelay: '1.8s' }}
        />
        {/* Faint static rings for depth (3D-ish layering). */}
        <span className="absolute h-28 w-28 rounded-full border border-[#26262B]" />
        <span className="absolute h-16 w-16 rounded-full border border-[#26262B]" />
        {/* The target: red centre dot. */}
        <span className="absolute h-4 w-4 rounded-full bg-[#EF4444] shadow-[0_0_18px_rgba(239,68,68,0.9)]" />
        {/* Floating dots: green runners, red hunters. */}
        <span
          className="pakdam-anim-float absolute left-[22%] top-[18%] h-3 w-3 rounded-full bg-[#22C55E] shadow-[0_0_10px_rgba(34,197,94,0.8)]"
          style={{ animationDelay: '0.4s' }}
        />
        <span
          className="pakdam-anim-float absolute right-[20%] top-[26%] h-3 w-3 rounded-full bg-[#EF4444] shadow-[0_0_10px_rgba(239,68,68,0.8)]"
          style={{ animationDelay: '1.1s' }}
        />
        <span
          className="pakdam-anim-float absolute bottom-[20%] left-[30%] h-2.5 w-2.5 rounded-full bg-[#22C55E]/80"
          style={{ animationDelay: '1.7s' }}
        />
        <span
          className="pakdam-anim-float absolute bottom-[28%] right-[28%] h-2.5 w-2.5 rounded-full bg-[#EF4444]/80"
          style={{ animationDelay: '2.2s' }}
        />
      </div>

      <p
        className="pakdam-anim-rise pakdam-label mt-4"
        style={{ animationDelay: '0.05s' }}
      >
        Your city is the battlefield
      </p>
      <h1
        className="pakdam-anim-rise pakdam-display mt-3 text-[52px] text-white"
        style={{ animationDelay: '0.12s' }}
      >
        You are the
        <br />
        <span className="text-[#EF4444]">Target.</span>
      </h1>
      <p
        className="pakdam-anim-rise mt-3 text-[15px] text-[#A1A1AA]"
        style={{ animationDelay: '0.19s' }}
      >
        Hide. Run. Don&apos;t get caught.
      </p>

      <div className="pakdam-anim-rise mt-8" style={{ animationDelay: '0.26s' }}>
        <Button variant="primary" onClick={() => router.push('/create/mode')}>
          <span className="flex w-full items-center justify-between">
            <span className="text-left">
              <span className="block text-[17px] font-bold">HOST A GAME</span>
              <span className="mt-1 block text-[13px] font-medium text-white/80">
                START A NEW MATCH
              </span>
            </span>
            <span aria-hidden className="text-[20px]">
              →
            </span>
          </span>
        </Button>
      </div>

      <div className="pakdam-anim-rise mt-3" style={{ animationDelay: '0.33s' }}>
        <Button variant="blocked" onClick={() => router.push('/join')}>
          <span className="flex w-full items-center justify-between">
            <span className="text-left">
              <span className="block text-[17px] font-bold text-white">JOIN A GAME</span>
              <span className="mt-1 block text-[13px] font-medium text-[#A1A1AA]">
                ENTER A ROOM CODE TO JOIN
              </span>
            </span>
            <span aria-hidden className="text-[20px] text-white">
              →
            </span>
          </span>
        </Button>
      </div>

      {/* Short info: what Pakdam is and how one game works. Three small
          cards, one line each — enough to understand the game at a
          glance, nothing more. */}
      <section
        aria-label="How a game works"
        className="pakdam-anim-rise mt-8"
        style={{ animationDelay: '0.4s' }}
      >
        <p className="text-[15px] leading-snug text-[#A1A1AA]">
          Pakdam is real-world hide-and-seek on your city map — Hunters
          chase Runners, and a tag only counts when the Runner confirms it.
        </p>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <div className="rounded-[14px] border border-[#26262B] bg-[#141416] p-3">
            <p className="text-[20px] font-bold text-[#EF4444]">1</p>
            <p className="mt-1 text-[13px] font-semibold leading-snug text-white">
              Host creates a lobby
            </p>
            <p className="mt-1 text-[12px] leading-snug text-[#A1A1AA]">
              Pick a mode, draw the play zone.
            </p>
          </div>
          <div className="rounded-[14px] border border-[#26262B] bg-[#141416] p-3">
            <p className="text-[20px] font-bold text-[#EF4444]">2</p>
            <p className="mt-1 text-[13px] font-semibold leading-snug text-white">
              Players join with the code
            </p>
            <p className="mt-1 text-[12px] leading-snug text-[#A1A1AA]">
              2–30 players, no account needed.
            </p>
          </div>
          <div className="rounded-[14px] border border-[#26262B] bg-[#141416] p-3">
            <p className="text-[20px] font-bold text-[#EF4444]">3</p>
            <p className="mt-1 text-[13px] font-semibold leading-snug text-white">
              Hunters tag, Runners confirm
            </p>
            <p className="mt-1 text-[12px] leading-snug text-[#A1A1AA]">
              A QR scan seals every catch.
            </p>
          </div>
        </div>
      </section>

      <p className="mt-auto pt-8 text-center text-[13px] text-[#A1A1AA]">
        Free · No download · 2–30 players · No account needed.
      </p>
    </main>
  );
}
