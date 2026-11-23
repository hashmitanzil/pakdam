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
 * Playback (v30 — this was the silent-radio defect): `getRemoteStream()`
 * used to have ZERO callers, so a teammate's voice arrived over WebRTC
 * and was never played. `VoiceRadio` now owns one hidden `<audio>`
 * element per connected teammate: on `ontrack` the remote stream is
 * attached as `srcObject` and `play()` is called. The elements live in
 * this class (not in React) so voice keeps playing when the radio tab is
 * hidden — the floating PTT on the map tab must be heard too. Browsers
 * block `play()` without a user gesture, so a rejected `play()` sets
 * `playbackBlocked` (surfaced by RadioStrip as a "Tap to enable sound"
 * button) instead of failing silent; the PTT press itself is a gesture,
 * so `startTalking()` also retries playback. Team-only: elements are
 * created only for peer ids in the teammate list.
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
  /** Fired when `play()` is blocked by the browser (true) or unblocked (false). */
  onPlaybackBlockedChange?: (blocked: boolean) => void;
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
  /** One hidden `<audio>` element per connected teammate (v30 playback). */
  private audioElements = new Map<string, HTMLAudioElement>();
  /** True when the browser rejected `play()` — needs a user gesture. */
  private playbackBlocked = false;
  /** RadioStrip subscribes here (the play page cannot pass a callback — it owns no such prop). */
  private playbackBlockedListener: ((blocked: boolean) => void) | null = null;
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

  /** True when the browser blocked remote playback — needs a user tap. */
  get isPlaybackBlocked(): boolean {
    return this.playbackBlocked;
  }

  /** Teammate ids with a live hidden `<audio>` element attached. */
  get playbackPeerIds(): string[] {
    return [...this.audioElements.keys()];
  }

  /**
   * Subscribe to playback-blocked changes (RadioStrip uses this — the
   * play page constructs VoiceRadio without an `onPlaybackBlockedChange`
   * prop, so the strip subscribes directly). The listener is called
   * immediately with the current state, so a newly shown strip never
   * misses a blocked state that arrived while it was hidden.
   */
  setPlaybackBlockedListener(listener: ((blocked: boolean) => void) | null): void {
    this.playbackBlockedListener = listener;
    if (listener) listener(this.playbackBlocked);
  }

  /**
   * Retry `play()` on every attached element — call from a user gesture
   * (the PTT press, or RadioStrip's "Tap to enable sound" button).
   * Returns false while the browser still refuses playback.
   */
  async unlockPlayback(): Promise<boolean> {
    const attempts: Promise<void>[] = [];
    for (const el of this.audioElements.values()) {
      let result: unknown;
      try {
        result = el.play();
      } catch {
        // play() threw synchronously — no gesture has happened yet.
        this.setPlaybackBlocked(true);
        return false;
      }
      const asPromise = toPromise(result);
      if (asPromise) attempts.push(asPromise);
    }
    if (attempts.length === 0) {
      // No elements, or play() returned nothing to await: nothing is
      // blocked — a later track arrival attempts play() again.
      this.setPlaybackBlocked(false);
      return true;
    }
    const settled = await Promise.allSettled(attempts);
    const blocked = settled.some((r) => r.status === 'rejected');
    this.setPlaybackBlocked(blocked);
    return !blocked;
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
    // v30: stop every hidden <audio> element (pause, clear srcObject,
    // remove from the DOM) so no teammate keeps playing after disable.
    for (const peerId of [...this.audioElements.keys()]) {
      this.detachPlayback(peerId);
    }
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
    // The press is a user gesture — retry any playback the browser
    // blocked earlier, even if this press itself cannot talk (muted /
    // not ready): the listener still needs to hear teammates.
    void this.unlockPlayback();
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
    // v30: mute the hidden <audio> elements too — the element's own
    // muted flag is what actually silences playback.
    for (const el of this.audioElements.values()) {
      el.muted = muted;
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

  /** The remote audio stream for a teammate (v30: attached internally to a hidden `<audio>` element; kept for tests / debugging). */
  getRemoteStream(peerId: string): MediaStream | undefined {
    return this.remoteStreams.get(peerId);
  }

  /**
   * Attach a teammate's remote stream to their hidden `<audio>` element
   * (one element per teammate; a second track for the same peer reuses
   * the element) and start playback. Team-only: peers only exist for
   * ids that passed the teammate check in `handleSignal`, and this
   * re-checks the roster so a stale peer can never become audible.
   */
  private attachPlayback(peerId: string, stream: MediaStream): void {
    if (!this.teammates.includes(peerId)) return;
    let el: HTMLAudioElement | null | undefined = this.audioElements.get(peerId);
    if (!el) {
      el = createHiddenAudioElement();
      // No DOM / Audio constructor in this environment (SSR, or node
      // tests without a stub): the stream is still stored, so
      // getRemoteStream() stays available for inspection.
      if (!el) return;
      this.audioElements.set(peerId, el);
    }
    el.srcObject = stream;
    el.muted = this.muted;
    this.attemptPlay(el);
  }

  /** One `play()` attempt: a rejection means the browser wants a gesture — flag it, never fail silent. */
  private attemptPlay(el: HTMLAudioElement): void {
    let result: unknown;
    try {
      result = el.play();
    } catch {
      this.setPlaybackBlocked(true);
      return;
    }
    toPromise(result)?.catch(() => this.setPlaybackBlocked(true));
  }

  /** Stop a teammate's hidden element: pause, clear the stream, remove it from the DOM. */
  private detachPlayback(peerId: string): void {
    const el = this.audioElements.get(peerId);
    if (!el) return;
    this.audioElements.delete(peerId);
    try {
      el.pause();
    } catch {
      // Already paused.
    }
    el.srcObject = null;
    try {
      el.remove();
    } catch {
      // Never attached to the DOM.
    }
    if (this.audioElements.size === 0) this.setPlaybackBlocked(false);
  }

  private setPlaybackBlocked(blocked: boolean): void {
    if (this.playbackBlocked === blocked) return;
    this.playbackBlocked = blocked;
    this.options.onPlaybackBlockedChange?.(blocked);
    this.playbackBlockedListener?.(blocked);
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
      // Some browsers fire ontrack with a track but no streams array —
      // wrap the track so the voice is never lost for that reason.
      const stream =
        event.streams?.[0] ??
        (typeof MediaStream !== 'undefined' && event.track
          ? new MediaStream([event.track])
          : undefined);
      if (!stream) return;
      this.remoteStreams.set(peerId, stream);
      for (const track of stream.getAudioTracks()) track.enabled = !this.muted;
      // v30: this was the silent-radio defect — the stream used to sit
      // in the map with no caller. Attach it to a hidden <audio>
      // element and play it now.
      this.attachPlayback(peerId, stream);
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
    // v30: the teammate left / the peer closed — stop their audio
    // element too, or the last thing they said would keep a stale
    // element (and a stale stream) around.
    this.detachPlayback(peerId);
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

/**
 * One hidden `<audio>` element: created in the DOM (so it is inspectable
 * and really plays) and hidden from sight and screen readers. Falls back
 * to a detached `new Audio()` when there is no document body (SSR), and
 * to null when there is no DOM at all.
 */
function createHiddenAudioElement(): HTMLAudioElement | null {
  try {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const el = document.createElement('audio');
      el.style.display = 'none';
      el.setAttribute('aria-hidden', 'true');
      // playsInline keeps iOS Safari from taking over playback.
      el.setAttribute('playsinline', '');
      if (document.body && typeof document.body.appendChild === 'function') {
        document.body.appendChild(el);
      }
      return el;
    }
    if (typeof Audio !== 'undefined') {
      const el = new Audio();
      el.style.display = 'none';
      return el;
    }
    return null;
  } catch {
    return null;
  }
}

/** `play()` returns a promise in browsers, undefined in some stubs — normalise. */
function toPromise(value: unknown): Promise<void> | null {
  if (value && typeof (value as { then?: unknown }).then === 'function') {
    return value as Promise<void>;
  }
  return null;
}
