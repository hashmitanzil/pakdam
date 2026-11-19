/**
 * Voice radio — WebRTC push-to-talk, team-only (PROTOCOL-MAP §6, R8).
 *
 * Audio flows DIRECTLY between teammates over WebRTC. The Worker/DO never
 * receives audio: it only forwards tiny SDP/ICE signalling payloads
 * (`voice.signal`) from one seat to one teammate, and the DO rejects any
 * signal whose sender and recipient are not on the same team.
 *
 * NAT: FREE PUBLIC STUN ONLY (VOICE_STUN_SERVERS from @pakdam/shared).
 * No TURN relay, no server, no recording, no storage. If direct P2P fails
 * (e.g. both behind symmetric NAT), the peer connection fails and the UI
 * says so in plain words — the game and the text radio keep working.
 * No MediaRecorder anywhere — audio is never written to disk, localStorage
 * or the server.
 *
 * Push-to-talk: hold to talk, max 10 s per burst (VOICE_MAX_BURST_MS).
 * The mic track is DISABLED except while the button is held. Mute silences
 * both directions (mic off + remote playback muted).
 *
 * Mesh + exactly-one-offerer: every voice-enabled teammate connects to
 * every other voice-enabled teammate. When A enables voice it sends `join`
 * to each teammate; a teammate already voice-enabled replies with an
 * `offer` (so exactly one side offers — no glare). `join`/`leave` are
 * presence (no SDP); `offer`/`answer` carry SDP (≤ 8 KB); `ice` carries one
 * ICE candidate. Payloads carry player ids only — never audio, never
 * coordinates, never a token.
 *
 * PTT states: idle / listening / talking (see `PttState`); the radio
 * status is `off | ready | talking | unavailable | failed`
 * (VoiceRadioStatus from @pakdam/shared).
 */
import {
  VOICE_MAX_BURST_MS,
  VOICE_SDP_MAX_BYTES,
  VOICE_STUN_SERVERS,
  type VoiceRadioStatus,
  type VoiceSignalKind,
} from '@pakdam/shared';

export type { VoiceRadioStatus, VoiceSignalKind };

export const VOICE_FAILURE_COPY =
  "Voice didn't connect — text radio still works.";

/** Push-to-talk button state. */
export type PttState = 'idle' | 'listening' | 'talking';

export interface VoiceSignal {
  fromPlayerId: string;
  toPlayerId: string;
  kind: VoiceSignalKind;
  sdp?: string;
  candidate?: unknown;
}

export interface VoiceRadioOptions {
  myPlayerId: string;
  /** Team-mate ids (team-only: never signal a player on the other team). */
  teammateIds: string[];
  /** Sends a signalling payload to one teammate (via the WS client). */
  sendSignal: (signal: VoiceSignal) => boolean;
  onStatusChange?: (status: VoiceRadioStatus, detail?: string) => void;
  onPttChange?: (state: PttState) => void;
  onTalkingChange?: (talking: boolean) => void;
}

export class VoiceRadio {
  readonly myPlayerId: string;

  private status: VoiceRadioStatus = 'off';
  private detail = '';
  private ptt: PttState = 'idle';
  private muted = false;
  private micStream: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private remoteStreams = new Map<string, MediaStream>();
  private connectedPeerIds = new Set<string>();
  private failedPeerIds = new Set<string>();
  private burstTimer: ReturnType<typeof setTimeout> | null = null;
  private burstStartedAtMs = 0;
  private handledSignals = new Set<string>();
  private teammates: string[];
  private readonly options: VoiceRadioOptions;

  constructor(options: VoiceRadioOptions) {
    this.options = options;
    this.myPlayerId = options.myPlayerId;
    this.teammates = [...options.teammateIds];
  }

  get radioStatus(): VoiceRadioStatus {
    return this.status;
  }

  get statusDetail(): string {
    return this.detail;
  }

  get pttState(): PttState {
    return this.ptt;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get isTalking(): boolean {
    return this.ptt === 'talking';
  }

  get connectedPeers(): string[] {
    return [...this.connectedPeerIds];
  }

  get failedPeers(): string[] {
    return [...this.failedPeerIds];
  }

  /** `Connected: N of M teammates.` */
  get connectionSummary(): string {
    return `Connected: ${this.connectedPeerIds.size} of ${this.teammates.length} teammates.`;
  }

  /** Enable voice: ask for the mic, keep the track disabled until held, then send `join` to each teammate. */
  async enable(): Promise<boolean> {
    if (this.status === 'ready' || this.status === 'talking') return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      this.micStream = stream;
      this.micTrack = stream.getAudioTracks()[0] ?? null;
      if (this.micTrack) this.micTrack.enabled = false; // disabled except while held
      this.setStatus('ready');
      for (const teammateId of this.teammates) {
        this.options.sendSignal({
          fromPlayerId: this.myPlayerId,
          toPlayerId: teammateId,
          kind: 'join',
        });
      }
      return true;
    } catch {
      this.setStatus('unavailable', 'Microphone unavailable — text radio still works.');
      return false;
    }
  }

  /** Disable: send `leave` to each teammate, close every peer connection, stop the mic. */
  disable(): void {
    this.stopTalking();
    for (const teammateId of this.teammates) {
      this.options.sendSignal({
        fromPlayerId: this.myPlayerId,
        toPlayerId: teammateId,
        kind: 'leave',
      });
    }
    for (const pc of this.peers.values()) {
      try {
        pc.close();
      } catch {
        // Already closed.
      }
    }
    this.peers.clear();
    this.remoteStreams.clear();
    this.connectedPeerIds.clear();
    this.failedPeerIds.clear();
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop();
      this.micStream = null;
      this.micTrack = null;
    }
    this.setStatus('off');
    this.setPtt('idle');
  }

  /** Replace the teammate list (e.g. after a roster change). */
  setTeammates(teammateIds: string[]): void {
    this.teammates = [...teammateIds];
  }

  /** Hold to talk: enables the mic track for at most one 10 s burst. */
  startTalking(): boolean {
    if (this.status !== 'ready' || this.muted || !this.micTrack) return false;
    this.micTrack.enabled = true;
    this.burstStartedAtMs = Date.now();
    this.setPtt('talking');
    this.setStatus('talking');
    this.burstTimer = setTimeout(() => this.stopTalking(), VOICE_MAX_BURST_MS);
    return true;
  }

  /** Release to talk: disables the mic track. */
  stopTalking(): void {
    if (this.burstTimer !== null) {
      clearTimeout(this.burstTimer);
      this.burstTimer = null;
    }
    if (this.micTrack) this.micTrack.enabled = false;
    if (this.status === 'talking') this.setStatus('ready');
    this.setPtt(this.muted ? 'idle' : 'listening');
    this.options.onTalkingChange?.(false);
  }

  /** Seconds elapsed in the current burst (0 when not talking). */
  burstElapsedSeconds(): number {
    if (this.ptt !== 'talking') return 0;
    return Math.min(
      VOICE_MAX_BURST_MS / 1000,
      (Date.now() - this.burstStartedAtMs) / 1000,
    );
  }

  /** Mute silences both directions (mic off + remote playback muted). */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stopTalking();
    if (this.micTrack) this.micTrack.enabled = !muted && this.ptt === 'talking';
    for (const stream of this.remoteStreams.values()) {
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
    }
  }

  /**
   * Handle an incoming `voice.signal`. Re-checks same-team membership
   * locally (unknown senders and own echoes ignored; ignored unless status
   * is ready/talking). Consumes each signal exactly once (ICE bursts send
   * many). Never triggers a snapshot.
   */
  async handleSignal(signal: VoiceSignal): Promise<void> {
    if (signal.toPlayerId !== this.myPlayerId) return; // not for me
    if (signal.fromPlayerId === this.myPlayerId) return; // own echo
    if (!this.teammates.includes(signal.fromPlayerId)) return; // not a teammate
    if (this.status !== 'ready' && this.status !== 'talking') return;
    const nonce = `${signal.fromPlayerId}:${signal.kind}:${typeof signal.sdp === 'string' ? signal.sdp.slice(0, 32) : ''}:${JSON.stringify(signal.candidate ?? null)}`;
    if (this.handledSignals.has(nonce)) return;
    this.handledSignals.add(nonce);
    if (this.handledSignals.size > 500) {
      // Bound the set; ICE bursts are short-lived.
      this.handledSignals.clear();
    }

    switch (signal.kind) {
      case 'join': {
        // A teammate already voice-enabled replies with an offer — exactly
        // one side offers, so there is no glare.
        await this.createOffer(signal.fromPlayerId);
        break;
      }
      case 'leave': {
        this.closePeer(signal.fromPlayerId);
        break;
      }
      case 'offer': {
        if (!signal.sdp || signal.sdp.length > VOICE_SDP_MAX_BYTES) return;
        await this.answerOffer(signal.fromPlayerId, signal.sdp);
        break;
      }
      case 'answer': {
        if (!signal.sdp || signal.sdp.length > VOICE_SDP_MAX_BYTES) return;
        const pc = this.peers.get(signal.fromPlayerId);
        if (pc && pc.signalingState === 'have-local-offer') {
          try {
            await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
          } catch {
            this.markFailed(signal.fromPlayerId);
          }
        }
        break;
      }
      case 'ice': {
        const pc = this.peers.get(signal.fromPlayerId);
        if (pc && signal.candidate) {
          try {
            await pc.addIceCandidate(signal.candidate as RTCIceCandidateInit);
          } catch {
            // Stale candidate — ignore.
          }
        }
        break;
      }
    }
  }

  /** The remote audio stream for a teammate (attach to an <audio> element). */
  getRemoteStream(peerId: string): MediaStream | undefined {
    return this.remoteStreams.get(peerId);
  }

  private async createOffer(peerId: string): Promise<void> {
    const pc = this.getOrCreatePeer(peerId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.options.sendSignal({
        fromPlayerId: this.myPlayerId,
        toPlayerId: peerId,
        kind: 'offer',
        sdp: offer.sdp,
      });
    } catch {
      this.markFailed(peerId);
    }
  }

  private async answerOffer(peerId: string, sdp: string): Promise<void> {
    const pc = this.getOrCreatePeer(peerId);
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.options.sendSignal({
        fromPlayerId: this.myPlayerId,
        toPlayerId: peerId,
        kind: 'answer',
        sdp: answer.sdp,
      });
    } catch {
      this.markFailed(peerId);
    }
  }

  private getOrCreatePeer(peerId: string): RTCPeerConnection {
    const existing = this.peers.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({
      iceServers: VOICE_STUN_SERVERS.map((url) => ({ urls: url })),
    });
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) pc.addTrack(track, this.micStream);
    }
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.options.sendSignal({
          fromPlayerId: this.myPlayerId,
          toPlayerId: peerId,
          kind: 'ice',
          candidate: event.candidate.toJSON(),
        });
      }
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream) {
        this.remoteStreams.set(peerId, stream);
        for (const track of stream.getAudioTracks()) track.enabled = !this.muted;
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.connectedPeerIds.add(peerId);
        this.failedPeerIds.delete(peerId);
        if (this.status === 'failed' && this.failedPeerIds.size === 0) {
          this.setStatus('ready');
        }
      } else if (
        pc.connectionState === 'failed' ||
        pc.connectionState === 'disconnected'
      ) {
        this.markFailed(peerId);
      }
    };
    this.peers.set(peerId, pc);
    return pc;
  }

  private closePeer(peerId: string): void {
    const pc = this.peers.get(peerId);
    if (pc) {
      try {
        pc.close();
      } catch {
        // Already closed.
      }
      this.peers.delete(peerId);
    }
    this.remoteStreams.delete(peerId);
    this.connectedPeerIds.delete(peerId);
  }

  private markFailed(peerId: string): void {
    this.failedPeerIds.add(peerId);
    this.connectedPeerIds.delete(peerId);
    this.setStatus('failed', VOICE_FAILURE_COPY);
  }

  private setStatus(status: VoiceRadioStatus, detail = ''): void {
    this.status = status;
    this.detail = detail;
    this.options.onStatusChange?.(status, detail);
  }

  private setPtt(state: PttState): void {
    this.ptt = state;
    this.options.onPttChange?.(state);
    if (state === 'talking') this.options.onTalkingChange?.(true);
  }
}
