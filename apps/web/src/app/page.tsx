'use client';

/**
 * Home (SCRAM-SPEC §3) — two actions and a headline, nothing else.
 *
 * HOST A GAME → Mode select (the room is created when a mode card is
 * tapped, with the host's codename). Join Room → the join screen for
 * that code, where the codename is entered. No counters, no Find-a-Room,
 * no paywall, no extra blocks.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { isValidRoomCode } from '@pakdam/shared';
import { Button } from '../components/ui/Button';

export default function HomePage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const join = (): void => {
    const normalized = code.trim().toUpperCase();
    if (!isValidRoomCode(normalized)) {
      setError("That code didn't match a room — check it and try again.");
      return;
    }
    router.push(`/join/${normalized}`);
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col px-4 pb-6 pt-6">
      <header className="flex items-center justify-between">
        <span className="pakdam-display text-[22px] text-white">Pakdam</span>
      </header>

      <p className="pakdam-label mt-10">Your city is the battlefield</p>
      <h1 className="pakdam-display mt-3 text-[52px] text-white">
        You are the
        <br />
        <span className="text-[#EF4444]">Target.</span>
      </h1>
      <p className="mt-3 text-[15px] text-[#A1A1AA]">Hide. Run. Don&apos;t get caught.</p>

      <div className="mt-8">
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

      <section
        aria-label="Join Room"
        className="mt-3 rounded-[16px] border border-[#26262B] bg-[#141416] p-4"
      >
        <p className="text-[17px] font-bold text-white">Join Room</p>
        <p className="mt-1 text-[13px] text-[#A1A1AA]">Enter a code to join a match.</p>
        <div className="mt-3 flex gap-2">
          <input
            value={code}
            onChange={(event) => {
              setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') join();
            }}
            placeholder="ABC123"
            aria-label="Room code"
            autoCapitalize="characters"
            autoComplete="off"
            className="h-14 min-w-0 flex-1 rounded-[14px] border border-[#26262B] bg-[#1E1E22] px-4 text-center text-[20px] font-bold uppercase tracking-[0.2em] text-white placeholder:text-[#A1A1AA]"
          />
          <button
            type="button"
            onClick={join}
            className="h-14 shrink-0 rounded-[14px] bg-[#EF4444] px-6 text-[17px] font-bold text-white active:bg-[#DC2626]"
          >
            JOIN
          </button>
        </div>
        {error ? <p className="mt-2 text-[13px] text-[#EF4444]">{error}</p> : null}
      </section>

      <p className="mt-auto pt-8 text-center text-[13px] text-[#A1A1AA]">
        Free · No download · 3–30 players · No account needed.
      </p>
    </main>
  );
}
