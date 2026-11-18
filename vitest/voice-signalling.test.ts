import { describe, expect, it } from 'vitest';
import { validateWsClientMessage } from '../workers/src/lib/validation.js';

/**
 * Voice signalling (D-M1) — inbound WS shape validation.
 * The DO's team-only enforcement is covered by the workers suite
 * (workers/test/voice-radio.test.ts, handleWsClientMessage); this
 * file covers the Zod shape gate: a well-formed voice.signal passes,
 * a malformed one is VALIDATION_FAILED before it reaches the DO.
 * Run: `npm run test:vitest` (root).
 */
const envelope = (type: string, payload: Record<string, unknown>) => ({
  v: 1, type, roomId: 'r1', playerId: 'me', clientTs: Date.now(),
  commandId: 'cmd-voice-1', payload,
});

describe('voice.signal shape validation', () => {
  it('accepts join / offer / answer / ice exactly as the web client sends them', () => {
    expect(validateWsClientMessage(envelope('voice.signal', { toPlayerId: 'mate-1', kind: 'join' })))
      .toMatchObject({ ok: true, mutating: true });
    expect(validateWsClientMessage(envelope('voice.signal', { toPlayerId: 'mate-1', kind: 'offer', sdp: 'v=0 offer' })))
      .toMatchObject({ ok: true, mutating: true });
    expect(validateWsClientMessage(envelope('voice.signal', { toPlayerId: 'mate-1', kind: 'answer', sdp: 'v=0 answer' })))
      .toMatchObject({ ok: true, mutating: true });
    expect(validateWsClientMessage(envelope('voice.signal', {
      toPlayerId: 'mate-1', kind: 'ice',
      candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    }))).toMatchObject({ ok: true, mutating: true });
  });
  it('rejects an unknown kind, a missing recipient, and an oversized SDP', () => {
    expect(validateWsClientMessage(envelope('voice.signal', { toPlayerId: 'mate-1', kind: 'shout' })))
      .toMatchObject({ ok: false });
    expect(validateWsClientMessage(envelope('voice.signal', { kind: 'join' })))
      .toMatchObject({ ok: false });
    expect(validateWsClientMessage(envelope('voice.signal', { toPlayerId: 'mate-1', kind: 'offer', sdp: 'x'.repeat(8193) })))
      .toMatchObject({ ok: false });
    expect(validateWsClientMessage(envelope('voice.signal', { toPlayerId: 'mate-1', kind: 'ice', candidate: { candidate: 'x'.repeat(1025) } })))
      .toMatchObject({ ok: false });
  });
});
