/**
 * RadioStrip — the team radio tab (SCRAM-SPEC §8d).
 *
 * Team-only: hunters see the Hunters channel, runners the Runners channel.
 * Text radio (≤ 140 chars, last 50, ephemeral) always works; voice is
 * push-to-talk over WebRTC P2P, free STUN only, no recording. When voice
 * cannot connect, one plain line says so — text radio still works.
 *
 * Quick chips are the closed set from `@pakdam/shared` (`QUICK_SIGNALS`).
 * In demo mode there is no voice radio and text stays on this device.
 */
'use client';

import { useState } from 'react';
import type { RadioMessage, Team, VoiceRadioStatus } from '@pakdam/shared';
import { QUICK_SIGNALS, RADIO_MAX_CHARS } from '@pakdam/shared';
import type { PttState, VoiceRadio } from '@/lib/voice-radio';
import { VOICE_FAILURE_COPY } from '@/lib/voice-radio';
import { PTTButton } from '@/components/radio/PTTButton';

export interface RadioStripProps {
  team: Team | null;
  /** e.g. `Hunters channel · 2 on air`. */
  channelLine: string;
  messages: RadioMessage[];
  /** System lines (head-start notice, etc.), centred, red, small. */
  notices: string[];
  myPlayerId: string;
  /** Hunters can be muted by the host setting — they read but cannot send. */
  canSend: boolean;
  /** Live voice radio, or null in demo mode. */
  voiceRadio: VoiceRadio | null;
  voiceStatus: VoiceRadioStatus;
  voiceDetail?: string;
  /** e.g. `Connected: 2 of 3 teammates.` — empty when nothing is connected. */
  voiceSummary: string;
  pttState: PttState;
  burstSeconds: number;
  muted: boolean;
  onToggleMute: () => void;
  onEnableVoice: () => void;
  onSendRadio: (text: string, kind?: 'quick' | 'text') => void;
}

export function RadioStrip({
  team,
  channelLine,
  messages,
  notices,
  myPlayerId,
  canSend,
  voiceRadio,
  voiceStatus,
  voiceDetail,
  voiceSummary,
  pttState,
  burstSeconds,
  muted,
  onToggleMute,
  onEnableVoice,
  onSendRadio,
}: RadioStripProps) {
  const [draft, setDraft] = useState('');
  const quick = team === 'hunters' ? QUICK_SIGNALS.hunters : QUICK_SIGNALS.runners;

  const sendDraft = () => {
    const text = draft.trim();
    if (!text || !canSend) return;
    onSendRadio(text.slice(0, RADIO_MAX_CHARS), 'text');
    setDraft('');
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[18px] font-bold text-white">Radio</h2>
          <p className="text-[13px] text-[#A1A1AA]">{channelLine}</p>
        </div>
        <button
          type="button"
          onClick={onToggleMute}
          aria-pressed={muted}
          className="rounded-full border border-[#26262B] bg-[#1E1E22] px-3 py-1 text-[13px] font-semibold text-white"
        >
          {muted ? 'Unmute' : 'Mute'}
        </button>
      </div>

      {/* Voice status — one line, plain words. */}
      {voiceRadio === null ? (
        <p className="text-[13px] text-[#A1A1AA]">
          Voice radio needs a live connection — text radio still works.
        </p>
      ) : voiceStatus === 'off' ? (
        <button
          type="button"
          onClick={onEnableVoice}
          className="self-start rounded-full border border-[#EF4444] px-3 py-1 text-[13px] font-semibold text-[#EF4444]"
        >
          Turn on voice
        </button>
      ) : voiceStatus === 'failed' || voiceStatus === 'unavailable' ? (
        <p className="text-[13px] text-[#A1A1AA]">{voiceDetail ?? VOICE_FAILURE_COPY}</p>
      ) : (
        <p className="text-[13px] text-[#A1A1AA]">
          {voiceSummary || (voiceStatus === 'talking' ? 'Talking…' : 'Voice ready.')}
        </p>
      )}

      {/* Messages — system lines centred, own messages red right, others grey left. */}
      <div className="flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto rounded-2xl border border-[#26262B] bg-[#141416] p-3">
        {notices.map((notice, i) => (
          <p key={`notice-${i}`} className="text-center text-[12px] text-[#EF4444]">
            {notice}
          </p>
        ))}
        {messages.length === 0 && notices.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-[#A1A1AA]">
            No messages yet — say something to your team.
          </p>
        ) : null}
        {messages.map((message) => {
          const mine = message.playerId === myPlayerId;
          return (
            <div key={message.messageId} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[80%] rounded-2xl px-3 py-2 ${
                  mine ? 'bg-[#EF4444] text-white' : 'bg-[#1E1E22] text-white'
                }`}
              >
                {!mine ? (
                  <p className="text-[12px] font-semibold text-[#A1A1AA]">{message.senderName}</p>
                ) : null}
                <p className="text-[15px]">{message.text}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Quick chips — tap sends that text. */}
      {canSend ? (
        <div className="flex flex-wrap gap-2">
          {quick.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => onSendRadio(chip, 'quick')}
              className="rounded-full border border-[#26262B] bg-[#1E1E22] px-3 py-1 text-[13px] font-semibold text-white"
            >
              {chip}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-[#A1A1AA]">
          Hunters can&apos;t talk in this game — you can still listen.
        </p>
      )}

      {/* Input row: text field + hold-to-talk mic. */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          maxLength={RADIO_MAX_CHARS}
          disabled={!canSend}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') sendDraft();
          }}
          placeholder={canSend ? 'Message your team' : 'Radio is listen-only for you'}
          aria-label="Message your team"
          className="h-12 min-h-0 flex-1 rounded-full border border-[#26262B] bg-[#1E1E22] px-4 text-[15px] text-white placeholder:text-[#A1A1AA]"
        />
        <PTTButton
          radio={voiceRadio}
          pttState={pttState}
          burstSeconds={burstSeconds}
          size="small"
          disabled={!canSend}
        />
        <button
          type="button"
          onClick={sendDraft}
          disabled={!canSend || draft.trim().length === 0}
          className="h-12 rounded-full bg-[#EF4444] px-4 text-[15px] font-bold text-white disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
