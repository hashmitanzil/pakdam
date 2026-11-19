/**
 * ClaimPicker — the name-only Runner picker (PROTOCOL-MAP §4.7, P0-2).
 *
 * Display names ONLY — no roles, no codes, no IDs. A pick that turns out
 * not to be a Runner is rejected by the server (live) or by `requestCatch`
 * (demo) with a plain-language error; no role is revealed by the
 * rejection. One primary action: the `I TAGGED <name>` button, enabled
 * only once a name is picked.
 */
'use client';

export interface ClaimPickerProps {
  names: { playerId: string; displayName: string }[];
  selectedId: string | null;
  onPick: (playerId: string) => void;
  onAction: () => void;
}

export function ClaimPicker({ names, selectedId, onPick, onAction }: ClaimPickerProps) {
  const selected = names.find((n) => n.playerId === selectedId);

  if (names.length === 0) {
    return (
      <p className="rounded-2xl border border-[#26262B] bg-[#141416] p-4 text-center text-[14px] text-[#A1A1AA]">
        No one left to tag.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {names.map((entry) => {
          const isSelected = entry.playerId === selectedId;
          return (
            <button
              key={entry.playerId}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onPick(entry.playerId)}
              className={`flex min-h-[56px] items-center justify-between rounded-2xl border px-4 text-left text-[17px] font-bold ${
                isSelected
                  ? 'border-[#EF4444] bg-[rgba(239,68,68,0.15)] text-white'
                  : 'border-[#26262B] bg-[#141416] text-white'
              }`}
            >
              <span>{entry.displayName}</span>
              {isSelected ? <span aria-hidden className="text-[#EF4444]">✓</span> : null}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onAction}
        disabled={!selected}
        className="flex h-14 w-full items-center justify-center rounded-[14px] bg-[#EF4444] px-4 text-[17px] font-bold text-white active:bg-[#DC2626] disabled:opacity-40"
      >
        {selected ? `I TAGGED ${selected.displayName.toUpperCase()}` : 'Pick a name first'}
      </button>
    </div>
  );
}
