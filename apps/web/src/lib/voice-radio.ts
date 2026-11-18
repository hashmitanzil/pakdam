/**
 * Free voice radio (D-M1) — WebRTC peer-to-peer, team-only.
 *
 * HOW IT WORKS (no paid service, no server relay, no recording):
 *  - Audio flows DIRECTLY between teammates over WebRTC
 *    (RTCPeerConnection). The game Worker NEVER receives audio: it
 *    only forwards tiny SDP/ICE signalling payloads (`voice.signal`)
 *    from one seat to one teammate, and the Durable Object rejects
 *    any signal whose sender and recipient are not on the same team.
 *  - NAT traversal uses FREE PUBLIC STUN ONLY
 *    (stun:stun.l.google.com:19302 + stun1) — a STUN server only
 *    tells a peer its own public address so the two can connect
 *    directly; it carries no audio and needs no account, key or
 *    payment. There is deliberately NO TURN server: if the two
 *    peers cannot connect directly (e.g. both behind symmetric NAT),
 *    the peer connection fails and the UI says so in plain words —
 *    the game and the text radio keep working.
 *  - Push-to-talk, SCRAM-style: hold to talk, ≤ 10 s per burst
 *    (VOICE_MAX_BURST_MS). The mic track is DISABLED except while
 *    the button is held, so nothing is sent between bursts.
 *  - Mesh: every voice-enabled teammate connects to every other
 *    voice-enabled teammate. Exactly one side offers: when A enables
 *    voice it sends `join` to each teammate; a teammate that is
 *    already voice-enabled replies with an `offer`. No glare, no
 *    central mixer.
 *  - Privacy: no recording, no storage — no MediaRecorder anywhere
 *    in this file, audio is never written to disk, localStorage or
 *    the server. Mute silences both directions (mic off + remote
 *    playback muted).
 *
 * This file has NO React and NO DOM except the default deps (real
 * RTCPeerConnection / getUserMedia / <audio> playback). Tests inject
 * mock deps, so the state machine is unit-testable in Node.
 */
import type { VoiceIceCandidate, VoiceSignalKind } from '@pakdam/shared';

/** One push-to-talk burst, SCRAM-style: hold to talk, max 10 s. */
export const VOICE_MAX_BURST_MS = 10_000;
/** Free public STUN only — no account, no key, no payment, no TURN.
 *  A STUN server only reveals each peer's own public address; it
 *  never carries audio. If direct P2P fails, voice falls back to
 *  text radio — never to a paid relay. */
export const VOICE_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
] as const;

export type VoiceStatus =
  | 'off' // voice not enabled on this device
  | 'ready' // mic acquired, mesh up (or joining), hold to talk
  | 'talking' // holding the button — mic live to the team
  | 'unavailable' // this browser/device cannot do WebRTC voice
  | 'failed'; // mic denied / P2P failed — text radio still works

export interface VoiceSignalOut {
  kind: VoiceSignalKind;
  sdp?: string;
  candidate?: VoiceIceCandidate;
}
export interface VoiceSignalIn extends VoiceSignalOut {
  fromPlayerId: string;
}
export interface VoiceTeammate {
  playerId: string;
  displayName: string;
}

export interface VoiceStatusInfo {
  status: VoiceStatus;
  /** Plain-words reason for 'unavailable' / 'failed' (shown in UI). */
  detail: string;
  /** Teammates with a live peer connection right now. */
  connectedPeerIds: string[];
  /** Teammates whose peer connection failed (direct P2P blocked). */
  failedPeerIds: string[];
  muted: boolean;
  talking: boolean;
}

export type VoiceStatusListener = (info: VoiceStatusInfo) => void;

/** Minimal surfaces of the WebRTC APIs this manager uses — real
 *  RTCPeerConnection / MediaStreamTrack satisfy them, and tests inject
 *  mocks with the same shape. */
export interface VoiceMediaTrack {
  enabled: boolean;
  stop(): void;
}
export interface VoiceMediaStream {
  getAudioTracks(): VoiceMediaTrack[];
}
export interface VoicePeerConnection {
  addTrack(track: VoiceMediaTrack, stream: VoiceMediaStream): void;
  createOffer(): Promise<{ type: 'offer'; sdp?: string }>;
  createAnswer(): Promise<{ type: 'answer'; sdp?: string }>;
  setLocalDescription(desc: { type: 'offer' | 'answer'; sdp?: string }): Promise<void>;
  setRemoteDescription(desc: { type: 'offer' | 'answer'; sdp?: string }): Promise<void>;
  addIceCandidate(candidate: VoiceIceCandidate): Promise<void>;
  close(): void;
  onicecandidate: ((ev: { candidate: VoiceIceCandidate | null }) => void) | null;
  ontrack: ((ev: { streams: VoiceMediaStream[] }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  connectionState: string;
}
export interface VoiceRtcDeps {
  createPeerConnection(config: { iceServers: { urls: string[] }[] }): VoicePeerConnection;
  getUserMedia(constraints: { audio: { echoCancellation: boolean; noiseSuppression: boolean } }): Promise<VoiceMediaStream>;
  /** Play one teammate's incoming audio. Default: an <audio> element. */
  playRemoteAudio(stream: VoiceMediaStream): void;
  /** Mute/unmute all remote playback (default: the <audio> elements). */
  setRemoteMuted(muted: boolean): void;
}

function defaultDeps(): VoiceRtcDeps | null {
  if (typeof window === 'undefined') return null;
  const RTCPeerConnectionCtor =
    window.RTCPeerConnection ??
    (window as unknown as { webkitRTCPeerConnection?: typeof RTCPeerConnection }).webkitRTCPeerConnection;
  if (!RTCPeerConnectionCtor || !navigator.mediaDevices?.getUserMedia) return null;
  const audioElements: HTMLAudioElement[] = [];
  return {
    createPeerConnection: (config) => new RTCPeerConnectionCtor(config) as unknown as VoicePeerConnection,
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints) as unknown as Promise<VoiceMediaStream>,
    playRemoteAudio: (stream) => {
      const el = document.createElement('audio');
      el.srcObject = stream as unknown as MediaStream;
      el.autoplay = true;
      // playsinline keeps iOS Safari from forcing fullscreen playback.
      el.setAttribute('playsinline', '');
      document.body.appendChild(el);
      audioElements.push(el);
      void el.play().catch(() => { /* autoplay blocked until a gesture — the PTT hold is the gesture */ });
    },
    setRemoteMuted: (muted) => { for (const el of audioElements) el.muted = muted; },
  };
}

/** True in a browser that can do WebRTC voice at all. */
export function isVoiceSupported(): boolean {
  return defaultDeps() !== null;
}

export class VoiceRadio {
  private readonly myPlayerId: string;
  private readonly deps: VoiceRtcDeps | null;
  private readonly sendSignal: (toPlayerId: string, signal: VoiceSignalOut) => boolean;
  private readonly onStatus: VoiceStatusListener;
  private teammates: VoiceTeammate[] = [];
  private peers = new Map<string, VoicePeerConnection>();
  private peerState = new Map<string, 'connecting' | 'connected' | 'failed'>();
  private stream: VoiceMediaStream | null = null;
  private track: VoiceMediaTrack | null = null;
  private status: VoiceStatus = 'off';
  private detail = '';
  private muted = false;
  private talking = false;
  private burstTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    myPlayerId: string,
    sendSignal: (toPlayerId: string, signal: VoiceSignalOut) => boolean,
    onStatus: VoiceStatusListener = () => { /* no listener */ },
    deps: VoiceRtcDeps | null = defaultDeps(),
  ) {
    this.myPlayerId = myPlayerId;
    this.sendSignal = sendSignal;
    this.onStatus = onStatus;
    this.deps = deps;
  }

  getStatus(): VoiceStatusInfo {
    return {
      status: this.status,
      detail: this.detail,
      connectedPeerIds: [...this.peerState.entries()].filter(([, v]) => v === 'connected').map(([k]) => k),
      failedPeerIds: [...this.peerState.entries()].filter(([, v]) => v === 'failed').map(([k]) => k),
      muted: this.muted,
      talking: this.talking,
    };
  }

  private emit(): void {
    this.onStatus(this.getStatus());
  }

  private fail(detail: string): void {
    this.stopBurstTimer();
    this.talking = false;
    if (this.track) this.track.enabled = false;
    this.status = 'failed';
    this.detail = detail;
    this.emit();
  }

  /** Enable voice for this device: ask for the mic, then announce
   *  to every teammate (`join`) so voice-enabled teammates offer a
   *  peer connection. Returns false (status 'failed'/'unavailable',
   *  text radio unaffected) when voice cannot start. */
  async enable(teammates: VoiceTeammate[]): Promise<boolean> {
    this.teammates = teammates.filter((t) => t.playerId !== this.myPlayerId);
    if (!this.deps) {
      this.status = 'unavailable';
      this.detail = 'This browser cannot do voice calls — use the text radio below.';
      this.emit();
      return false;
    }
    if (this.status === 'ready' || this.status === 'talking') return true;
    let stream: VoiceMediaStream;
    try {
      stream = await this.deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      this.status = 'failed';
      this.detail = 'Microphone unavailable — check the browser microphone permission, then try again. Text radio still works.';
      this.emit();
      return false;
    }
    const tracks = stream.getAudioTracks();
    if (tracks.length === 0) {
      this.status = 'failed';
      this.detail = 'No microphone track — text radio still works.';
      this.emit();
      return false;
    }
    this.stream = stream;
    this.track = tracks[0]!;
    // Mic stays DISABLED until the talk button is held (push-to-talk).
    this.track.enabled = false;
    this.status = 'ready';
    this.detail = '';
    this.emit();
    for (const t of this.teammates) this.sendSignal(t.playerId, { kind: 'join' });
    return true;
  }

  /** Leave voice: tell teammates, close every peer connection, stop
   *  the mic. Text radio is untouched. */
  disable(): void {
    this.stopBurstTimer();
    this.talking = false;
    for (const t of this.teammates) this.sendSignal(t.playerId, { kind: 'leave' });
    for (const pc of this.peers.values()) {
      try { pc.close(); } catch { /* already closed */ }
    }
    this.peers.clear();
    this.peerState.clear();
    if (this.track) {
      this.track.enabled = false;
      try { this.track.stop(); } catch { /* already stopped */ }
    }
    this.track = null;
    this.stream = null;
    this.status = 'off';
    this.detail = '';
    this.emit();
  }

  /** Hold to talk: mic live to the team, auto-stops at 10 s. */
  startTalk(): boolean {
    if (this.status !== 'ready' || this.muted || !this.track) return false;
    this.track.enabled = true;
    this.talking = true;
    this.status = 'talking';
    this.emit();
    this.stopBurstTimer();
    this.burstTimer = setTimeout(() => {
      // Burst cap (SCRAM-style): the mic cuts at 10 s — release and
      // press again to talk more. Never silently keep transmitting.
      this.stopTalk();
      this.detail = 'Talk burst ended at 10 seconds — release and press again to talk more.';
      this.emit();
    }, VOICE_MAX_BURST_MS);
    return true;
  }

  /** Release the talk button: mic off immediately. */
  stopTalk(): void {
    this.stopBurstTimer();
    if (this.track) this.track.enabled = false;
    this.talking = false;
    if (this.status === 'talking') {
      this.status = 'ready';
      this.detail = '';
    }
    this.emit();
  }

  /** Mute: mic off (and stops a burst) + teammates' audio muted. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.stopBurstTimer();
      this.talking = false;
      if (this.track) this.track.enabled = false;
      if (this.status === 'talking') this.status = 'ready';
    }
    this.deps?.setRemoteMuted(muted);
    this.emit();
  }

  /** One incoming `voice.signal` from a teammate (already checked by
   *  the DO to be same-team; re-checked here so a forged / stale
   *  client message can never open a peer connection to a stranger).
   *  Unknown senders and our own echoes are ignored. */
  async handleSignal(signal: VoiceSignalIn): Promise<void> {
    const from = signal.fromPlayerId;
    if (from === this.myPlayerId) return;
    if (!this.teammates.some((t) => t.playerId === from)) return;
    if (this.status === 'off' || this.status === 'unavailable' || this.status === 'failed') return;
    if (!this.deps || !this.stream || !this.track) return;
    switch (signal.kind) {
      case 'join': {
        // The joiner is voice-enabled: WE offer (exactly one offerer).
        const pc = this.ensurePeer(from);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          if (offer.sdp) this.sendSignal(from, { kind: 'offer', sdp: offer.sdp });
        } catch {
          this.markPeerFailed(from, 'Could not start a voice call to a teammate — text radio still works.');
        }
        return;
      }
      case 'leave': {
        this.closePeer(from);
        return;
      }
      case 'offer': {
        if (typeof signal.sdp !== 'string') return;
        const pc = this.ensurePeer(from);
        try {
          await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (answer.sdp) this.sendSignal(from, { kind: 'answer', sdp: answer.sdp });
        } catch {
          this.markPeerFailed(from, 'Could not answer a voice call — text radio still works.');
        }
        return;
      }
      case 'answer': {
        if (typeof signal.sdp !== 'string') return;
        const pc = this.peers.get(from);
        if (!pc) return;
        try {
          await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        } catch {
          this.markPeerFailed(from, 'Voice call setup failed — text radio still works.');
        }
        return;
      }
      case 'ice': {
        if (!signal.candidate) return;
        const pc = this.peers.get(from);
        if (!pc) return;
        try {
          await pc.addIceCandidate(signal.candidate);
        } catch {
          // One bad candidate never kills the call — the rest may
          // still connect. Ignore it.
        }
        return;
      }
    }
  }

  private ensurePeer(peerId: string): VoicePeerConnection {
    const existing = this.peers.get(peerId);
    if (existing) return existing;
    const pc = this.deps!.createPeerConnection({
      // STUN ONLY — no TURN relay, no credentials, nothing paid.
      iceServers: VOICE_STUN_URLS.map((urls) => ({ urls: [urls] })),
    });
    if (this.track && this.stream) pc.addTrack(this.track, this.stream);
    this.peerState.set(peerId, 'connecting');
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.sendSignal(peerId, { kind: 'ice', candidate: ev.candidate });
    };
    pc.ontrack = (ev) => {
      const remote = ev.streams[0];
      if (remote) this.deps!.playRemoteAudio(remote);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.peerState.set(peerId, 'connected');
        this.emit();
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        // Direct P2P blocked (e.g. symmetric NAT on both sides) with
        // no TURN to fall back to: say so plainly, close the peer,
        // keep the game + text radio running. Never retry in a loop.
        this.markPeerFailed(peerId, 'Voice could not connect directly to a teammate (network blocks direct calls) — text radio still works.');
      }
    };
    this.peers.set(peerId, pc);
    this.emit();
    return pc;
  }

  private markPeerFailed(peerId: string, detail: string): void {
    this.peerState.set(peerId, 'failed');
    this.closePeerConnection(peerId);
    this.detail = detail;
    this.emit();
  }

  private closePeer(peerId: string): void {
    this.closePeerConnection(peerId);
    this.peerState.delete(peerId);
    this.emit();
  }

  private closePeerConnection(peerId: string): void {
    const pc = this.peers.get(peerId);
    if (pc) {
      try { pc.close(); } catch { /* already closed */ }
      this.peers.delete(peerId);
    }
  }

  private stopBurstTimer(): void {
    if (this.burstTimer !== null) {
      clearTimeout(this.burstTimer);
      this.burstTimer = null;
    }
  }
}
