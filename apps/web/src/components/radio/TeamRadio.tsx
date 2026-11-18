'use client';
import { useEffect, useRef, useState } from 'react';
import styles from './radio.module.css';
import { VoiceRadio, VOICE_MAX_BURST_MS, type VoiceSignalIn, type VoiceSignalOut, type VoiceStatusInfo } from '../../lib/voice-radio';
import type { RadioMessage as ServerRadioMessage } from '@pakdam/shared';

/** Live voice transport, supplied by the play page (the only screen
 *  that owns the game socket + the teammate list). Absent in demo
 *  mode and in the lobby (no teams yet) — voice is then unavailable
 *  and the text radio below is the whole radio. */
export interface VoiceTransport {
  myPlayerId: string | null;
  teammates: { playerId: string; displayName: string }[];
  /** Send one signalling payload to one teammate over the game
   *  socket. Returns false when the socket is not connected. */
  sendSignal: (toPlayerId: string, signal: VoiceSignalOut) => boolean;
  /** Latest incoming `voice.signal`, with a nonce so the same
   *  payload is consumed exactly once. */
  incomingSignal: (VoiceSignalIn & { nonce: number }) | null;
}

export interface RadioMessage {
  id: string;
  sender: string;
  text: string;
  at: string;
  kind: 'quick' | 'text';
}

/** Live TEXT transport (D-M7), supplied by the screen that owns the
 *  game socket (play page, lobby page). Absent in demo mode — text
 *  then stays on this device (localStorage, as before). When present,
 *  messages arrive from the server (`radio` broadcasts, team-only via
 *  the DO — lobby scope: the whole lobby) and sends go over the
 *  socket; nothing is stored locally. Radio is ephemeral: a message
 *  sent while this seat is offline is never delivered later. */
export interface LiveTextTransport {
  /** Server radio messages for this scope, oldest first. */
  messages: ServerRadioMessage[];
  /** True while the game socket is connected. */
  connected: boolean;
  /** Send one text / quick message over the socket. Returns false
   *  when the socket is not connected (the message is discarded). */
  send: (text: string, kind: 'quick' | 'text') => boolean;
}

/** Quick messages — our own words, closed set. These are the only
 *  one-tap messages; free text is capped at 140 characters. The set is
 *  role-specific so Hunters coordinate a sweep and Runners coordinate
 *  staying hidden, without naming any real place. */
export const QUICK_MESSAGES = [
  'Ready when you are',
  'Give me a minute',
  'Check the boundary first',
  'I’m here — where is everyone?',
  'Let’s go!',
] as const;

export const HUNTER_QUICK_MESSAGES = [
  'Cover the far edge',
  'Hold the boundary',
  'Moving to the next ping area',
  'I need backup',
  'All clear on my side',
] as const;

export const RUNNER_QUICK_MESSAGES = [
  'I’m safe for now',
  'Moving to a new spot',
  'Stay spread out',
  'Don’t bunch up',
  'Heads up — hunter nearby',
] as const;

const MAX_MESSAGES = 50;
const MAX_TEXT = 140;
const HOLD_MS = 600;

function loadMessages(roomId: string, scope: string): RadioMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(`pakdam.radio.${scope}.${roomId}`) ?? '[]') as RadioMessage[];
  } catch {
    return [];
  }
}

function saveMessages(roomId: string, scope: string, messages: RadioMessage[]): void {
  localStorage.setItem(`pakdam.radio.${scope}.${roomId}`, JSON.stringify(messages.slice(-MAX_MESSAGES)));
}

function loadBlocked(roomId: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(`pakdam.radio.blocked.${roomId}`) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/** Team Radio — text + quick messages, team-only, plus FREE voice
 *  push-to-talk (D-M1) when the play page supplies a voice transport.
 *  Voice is WebRTC peer-to-peer within the team only: the mic is live
 *  only while the talk button is held (≤ 10 s per burst), audio goes
 *  straight to teammates (free public STUN only, no TURN, no server
 *  relay, no recording, no storage), and the game server only
 *  forwards the tiny SDP/ICE setup messages — team-only, enforced by
 *  the Durable Object. If direct peer-to-peer fails (e.g. symmetric
 *  NAT), voice reports it in plain words and the text radio below
 *  keeps working; the game never breaks for voice.
 *  In the lobby the teams do not exist yet (roles are assigned
 *  at game start), so the radio is scoped to the whole lobby and labelled
 *  as such; once roles exist, pass scope="hunters" | "runners" and only
 *  that team reads it.
 *  Press and hold a message (600 ms) to report it or block its sender.
 *  Reports and blocks are stored on this device only in this demo — they
 *  are not sent to a server, and the host is told to check in person.
 *  Demo storage: messages live in this browser's localStorage only —
 *  nothing is sent to a server and nothing leaves the device. In a
 *  live game (liveText supplied) the server is the radio: messages
 *  arrive over the socket and sends go over the socket — the local
 *  store is not read or written at all. */
export default function TeamRadio({
  roomId,
  scope,
  meName,
  huntersCanTalk = true,
  voice,
  liveText,
}: {
  roomId: string;
  scope: 'lobby' | 'hunters' | 'runners';
  meName: string | null;
  /** Host setting: false = the Hunters' radio channel is off for this
   *  game (Hunters cannot send; Runners can still use theirs). */
  huntersCanTalk?: boolean;
  /** Live voice transport (play page only). Omit in demo / lobby. */
  voice?: VoiceTransport;
  /** Live text transport (play + lobby pages, live mode only).
   *  Omit in demo mode — text then stays on this device. */
  liveText?: LiveTextTransport;
}) {
  const [localMessages, setLocalMessages] = useState<RadioMessage[]>([]);
  // Live mode: the server's messages, mapped to the local shape the
  // list renders (messageId → id, senderName → sender, sentAt → at).
  // Demo mode: the localStorage messages below.
  const isLiveText = liveText !== undefined;
  const messages: RadioMessage[] = isLiveText
    ? liveText.messages.map((m) => ({ id: m.messageId, sender: m.senderName, text: m.text, at: m.sentAt, kind: m.kind }))
    : localMessages;
  const [draft, setDraft] = useState('');
  const [sentNote, setSentNote] = useState('');
  const [heldId, setHeldId] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [actionNote, setActionNote] = useState('');
  const holdTimerRef = useRef<number | null>(null);
  // --- Voice radio (D-M1) ---
  const voiceManagerRef = useRef<VoiceRadio | null>(null);
  const [voiceInfo, setVoiceInfo] = useState<VoiceStatusInfo | null>(null);
  const [talkStartedAt, setTalkStartedAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Latest transport, read at press time (the play page re-creates the
  // `voice` object every render — the manager must NOT be re-created
  // for that, or every peer connection would drop).
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const voiceAvailable = scope !== 'lobby' && voice !== undefined && voice.myPlayerId !== null;
  /** Host turned the Hunters' radio off: Hunters read but cannot send. */
  const huntersMuted = scope === 'hunters' && huntersCanTalk === false;

  useEffect(() => {
    if (!voiceAvailable || !voice?.myPlayerId) return;
    const manager = new VoiceRadio(voice.myPlayerId, (to, signal) => voiceRef.current?.sendSignal(to, signal) ?? false, (info) => setVoiceInfo(info));
    voiceManagerRef.current = manager;
    setVoiceInfo(manager.getStatus());
    return () => {
      manager.disable();
      voiceManagerRef.current = null;
      setVoiceInfo(null);
      setTalkStartedAt(null);
    };
    // Re-create only when the seat or the team channel changes — never
    // on a re-render (see voiceRef above).
  }, [voiceAvailable, voice?.myPlayerId, scope]);

  // Incoming voice signalling from a teammate (play page forwards the
  // socket's `voice.signal` here). The nonce makes each delivery unique.
  const incomingNonce = voice?.incomingSignal?.nonce ?? null;
  useEffect(() => {
    const incoming = voiceRef.current?.incomingSignal;
    if (!incoming || !voiceManagerRef.current) return;
    void voiceManagerRef.current.handleSignal(incoming);
  }, [incomingNonce]);

  // Burst countdown tick — only while talking.
  useEffect(() => {
    if (!voiceInfo?.talking) return;
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, [voiceInfo?.talking]);

  const enableVoice = () => {
    const manager = voiceManagerRef.current;
    if (!manager || huntersMuted) return;
    void manager.enable(voiceRef.current?.teammates ?? []);
  };
  const disableVoice = () => {
    voiceManagerRef.current?.disable();
    setTalkStartedAt(null);
  };
  const startTalking = () => {
    if (voiceManagerRef.current?.startTalk()) setTalkStartedAt(Date.now());
  };
  const stopTalking = () => {
    voiceManagerRef.current?.stopTalk();
    setTalkStartedAt(null);
  };
  const burstRemainingSeconds = talkStartedAt !== null
    ? Math.max(0, Math.ceil((VOICE_MAX_BURST_MS - (nowMs - talkStartedAt)) / 1000))
    : null;

  useEffect(() => {
    // Live mode: the server owns the messages — do not read or poll
    // the local store (a stale local message must never appear as
    // a live one). Demo mode only.
    if (isLiveText) { setLocalMessages([]); return; }
    setLocalMessages(loadMessages(roomId, scope));
    setBlocked(loadBlocked(roomId));
    const id = setInterval(() => setLocalMessages(loadMessages(roomId, scope)), 1000);
    return () => clearInterval(id);
  }, [roomId, scope, isLiveText]);

  useEffect(
    () => () => {
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    },
    [],
  );

  const quickMessages: readonly string[] =
    scope === 'hunters' ? HUNTER_QUICK_MESSAGES : scope === 'runners' ? RUNNER_QUICK_MESSAGES : QUICK_MESSAGES;
  const scopeLabel = scope === 'lobby' ? 'Lobby radio' : scope === 'hunters' ? 'Hunter radio ◆ H' : 'Runner radio ▲ R';
  const scopeNote =
    scope === 'lobby'
      ? 'Everyone in this lobby can read these messages. Once the game starts, radio becomes team-only: Hunters and Runners each get their own channel.'
      : scope === 'hunters'
        ? 'Only Hunters can read this channel. Runners never see it — and you never see theirs.'
        : 'Only Runners can read this channel. Hunters never see it — and you never see theirs.';

  const send = (text: string, kind: 'quick' | 'text') => {
    const clean = text.trim();
    if (!clean || !meName) return;
    if (isLiveText) {
      // Live mode: over the socket to the team. A failed send
      // (socket not connected) discards the message — the note says
      // so plainly instead of pretending it arrived.
      const ok = liveText.send(clean, kind);
      setDraft('');
      setSentNote(ok ? 'Sent ✓' : 'Not connected — message not sent. Try again when reconnected.');
      window.setTimeout(() => setSentNote(''), 3000);
      return;
    }
    const next = [...localMessages, { id: crypto.randomUUID(), sender: meName, text: clean, at: new Date().toISOString(), kind }];
    saveMessages(roomId, scope, next);
    setLocalMessages(next.slice(-MAX_MESSAGES));
    setDraft('');
    setSentNote('Sent ✓');
    window.setTimeout(() => setSentNote(''), 2000);
  };

  const startHold = (id: string) => {
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = window.setTimeout(() => setHeldId(id), HOLD_MS);
  };
  const cancelHold = () => {
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  };

  const report = (m: RadioMessage) => {
    try {
      const key = `pakdam.radio.reports.${roomId}`;
      const prev = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[];
      localStorage.setItem(key, JSON.stringify([...prev, { messageId: m.id, sender: m.sender, text: m.text, at: m.at, reporter: meName }]));
    } catch {
      /* storage unavailable — the note below still tells the player what to do */
    }
    setHeldId(null);
    setActionNote(`Reported “${m.text}” — saved on this device only. Tell the host in person; reports are not sent to a server.`);
  };

  const blockSender = (sender: string) => {
    const next = [...new Set([...blocked, sender])];
    setBlocked(next);
    try {
      localStorage.setItem(`pakdam.radio.blocked.${roomId}`, JSON.stringify(next));
    } catch {
      /* storage unavailable — the block still applies for this session */
    }
    setHeldId(null);
    setActionNote(`Blocked ${sender} on this device — their messages are hidden for you. Blocking is local only.`);
  };

  const visible = messages.filter((m) => !blocked.includes(m.sender));
  const hiddenCount = messages.length - visible.length;

  return (
    <section className={`card ${styles.radioCard}`} aria-label={scopeLabel}>
      <h2 className={styles.radioTitle}>📻 {scopeLabel}</h2>
      <p className={styles.radioSub}>{scopeNote}</p>
      <p className={styles.voiceNote}>
        <strong>Voice is peer-to-peer, no recording.</strong> Your voice goes straight to your own team
        only — the other team never hears it, it is never recorded or stored, and there is no voice
        server. Setup uses a free public STUN server only, so if your network blocks direct calls,
        voice simply won’t connect and the text radio below still works.
      </p>
      {scope === 'lobby' ? (
        <p className="small">Voice starts when teams are assigned at match start — until then, use the text radio below.</p>
      ) : !voiceAvailable ? (
        <p className="small">
          Voice needs the live game connection — in demo mode there is no live connection, so use the
          text radio below. In a live game, turn voice on here to talk to your team.
        </p>
      ) : huntersMuted ? (
        <p role="status"><strong>Hunters’ radio is off in this game.</strong> The host turned it off — Hunters cannot send voice or text radio messages. Runners can still use theirs.</p>
      ) : (
        <div className={styles.voicePanel} aria-label="Voice radio">
          {voiceInfo && voiceInfo.status !== 'off' ? (
            <>
              <p role="status" className="small">
                {voiceInfo.status === 'talking'
                  ? `🎙️ Talking to your team… ${burstRemainingSeconds ?? 10}s left in this burst (max 10s).`
                  : voiceInfo.status === 'ready'
                    ? `Voice on — hold the button to talk to your team. Connected: ${voiceInfo.connectedPeerIds.length} of ${voice?.teammates.length ?? 0} teammate${(voice?.teammates.length ?? 0) === 1 ? '' : 's'}.${voiceInfo.detail ? ` ${voiceInfo.detail}` : ''}`
                    : voiceInfo.status === 'failed' || voiceInfo.status === 'unavailable'
                      ? `Voice unavailable — ${voiceInfo.detail}`
                      : 'Voice on.'}
              </p>
              {voiceInfo.failedPeerIds.length > 0 ? (
                <p className="small">
                  Couldn’t connect voice directly to {voiceInfo.failedPeerIds.length} teammate
                  {voiceInfo.failedPeerIds.length === 1 ? '' : 's'} (their network blocks direct calls).
                  Text radio below still reaches them.
                </p>
              ) : null}
              <div className={styles.voiceRow}>
                <button
                  type="button"
                  className={`${styles.pttButton} ${voiceInfo.talking ? styles.pttTalking : ''}`}
                  disabled={voiceInfo.muted || voiceInfo.status === 'failed' || voiceInfo.status === 'unavailable'}
                  onPointerDown={startTalking}
                  onPointerUp={stopTalking}
                  onPointerLeave={stopTalking}
                  onPointerCancel={stopTalking}
                  onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startTalking(); } }}
                  onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') stopTalking(); }}
                  onContextMenu={(e) => e.preventDefault()}
                  aria-label="Hold to talk to your team (max 10 seconds per burst)"
                >
                  {voiceInfo.talking ? '🎙️ Talking… release to stop' : '🎙️ Hold to talk'}
                </button>
                <button
                  type="button"
                  className={styles.muteButton}
                  onClick={() => voiceManagerRef.current?.setMuted(!voiceInfo.muted)}
                  aria-pressed={voiceInfo.muted}
                >
                  {voiceInfo.muted ? '🔇 Unmute' : '🔊 Mute'}
                </button>
                <button type="button" className={styles.muteButton} onClick={disableVoice}>
                  Turn voice off
                </button>
              </div>
              <p className="small">Hold to talk, max 10 seconds per burst — like a walkie-talkie. Mute silences your mic and your teammates’ voices.</p>
            </>
          ) : (
            <>
              <p className="small">
                Turn voice on to talk to your team hands-free-ish: hold the button, speak, release.
                Your browser will ask for microphone permission.
              </p>
              <button type="button" className="btn" onClick={enableVoice}>
                🎙️ Turn voice on
              </button>
            </>
          )}
        </div>
      )}
      {!meName ? (
        <p>You are not signed in as a player on this device, so you cannot send radio messages. Join the game first.</p>
      ) : (
        <>
          {messages.length === 0 ? (
            <p className="small">No messages yet — say hello, or tap a quick message below.</p>
          ) : (
            <>
              <ul className={styles.messageList}>
                {visible.map((m) => (
                  <li
                    key={m.id}
                    className={`${styles.message} ${m.sender === meName ? styles.messageMine : ''} ${heldId === m.id ? styles.messageHeld : ''}`}
                    onPointerDown={() => startHold(m.id)}
                    onPointerUp={cancelHold}
                    onPointerLeave={cancelHold}
                    onPointerCancel={cancelHold}
                    onContextMenu={(e) => e.preventDefault()}
                  >
                    <span className={styles.messageSender}>
                      {m.sender}
                      {m.kind === 'quick' ? ' · quick message' : ''}
                      <span className={styles.messageTime}>{new Date(m.at).toLocaleTimeString()}</span>
                    </span>
                    <div className={styles.messageText}>{m.text}</div>
                    {heldId === m.id ? (
                      <span className={styles.reportRow} role="group" aria-label={`Report or block ${m.sender}`}>
                        <button type="button" onClick={() => report(m)}>
                          Report
                        </button>
                        <button type="button" onClick={() => blockSender(m.sender)}>
                          Block {m.sender}
                        </button>
                        <button type="button" onClick={() => setHeldId(null)}>
                          Cancel
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {hiddenCount > 0 ? (
                <p className="small">
                  {hiddenCount} message{hiddenCount === 1 ? '' : 's'} hidden — from a player you blocked on
                  this device.
                </p>
              ) : null}
              <p className="small">Press and hold a message to report it or block its sender.</p>
            </>
          )}
          {actionNote ? (
            <p role="status" className="small">
              {actionNote}
            </p>
          ) : null}
          {huntersMuted ? (
            <p role="status"><strong>Hunters’ radio is off in this game.</strong> The host turned it off — Hunters cannot send radio messages. Runners can still use theirs.</p>
          ) : (
            <>
              <div className={styles.quickRow} role="group" aria-label="Quick messages">
                {quickMessages.map((q) => (
                  <button key={q} type="button" className={styles.quickChip} onClick={() => send(q, 'quick')}>
                    {q}
                  </button>
                ))}
              </div>
              <form
                className={styles.composer}
                onSubmit={(e) => {
                  e.preventDefault();
                  send(draft, 'text');
                }}
              >
                <label htmlFor={`radio-draft-${scope}`} className="small" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                  Type a radio message
                </label>
                <input
                  id={`radio-draft-${scope}`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={MAX_TEXT}
                  placeholder="Type a short message…"
                  autoComplete="off"
                />
                <button type="submit" className="btn" disabled={!draft.trim()}>
                  Send
                </button>
              </form>
              <p className="small">
                {draft.length}/{MAX_TEXT} characters · Last {MAX_MESSAGES} messages kept
                {isLiveText
                  ? ` · Live — messages go to your team through the game server${liveText.connected ? '' : ' · reconnecting — messages sent now are discarded'}`
                  : ' on this device · Messages stay in this browser and are never sent to a server.'}
                {sentNote ? ` ${sentNote}` : ''}
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
