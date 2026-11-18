import { describe, expect, it } from 'vitest';
import { validateWsClientMessage } from '../workers/src/lib/validation.js';
import { createRoomBody, joinBody, ticketBody } from '../workers/src/http.js';
import { parseGameEvent, safeParseGameEvent } from '../packages/shared/src/events.js';

/**
 * Worker validation under Vitest (TS source directly). The full worker
 * suite stays `node --test` (`workers/test/*.test.ts`); these are the
 * Vitest-side checks for the real-Zod wiring: HTTP bodies, stored game
 * events, and inbound WS client messages (`workers/src/lib/validation.ts`).
 * Payload shapes mirror the real web client
 * (`apps/web/src/lib/websocket.ts` `sendCommand` — fields nested under
 * `payload`), not the k6 script's top-level shape.
 */
const roomId = '11111111-1111-4111-8111-111111111111';
const playerId = '22222222-2222-4222-8222-222222222222';
const fix = {
  playerId, roomId, lat: 23.352, lng: 85.321, accuracyMeters: 8,
  capturedAt: '2026-11-17T10:00:00.000Z', receivedAt: '2026-11-17T10:00:01.000Z',
  quality: 'good' as const,
};
const envelope = (type: string, payload: Record<string, unknown>) => ({
  v: 1, type, roomId, playerId, clientTs: Date.now(),
  commandId: 'cmd-1', payload,
});

describe('inbound WS client messages (real Zod)', () => {
  it('accepts a location.update exactly as the web client sends it', () => {
    expect(validateWsClientMessage(envelope('location.update', { fix }))).toMatchObject({ ok: true, mutating: true });
  });
  it('rejects a location.update with the fix at top level (not under payload)', () => {
    // The DO reads payload['fix']; a bare top-level fix is never read.
    const raw = { v: 1, type: 'location.update', roomId, playerId, commandId: 'cmd-1', fix };
    expect(validateWsClientMessage(raw)).toMatchObject({ ok: false });
  });
  it('rejects a fix outside the latitude range', () => {
    const bad = envelope('location.update', { fix: { ...fix, lat: 91 } });
    expect(validateWsClientMessage(bad)).toMatchObject({ ok: false });
  });
  it('accepts a fix carrying a junk field (SEC-07: the DO drops it on store, never rejects the message)', () => {
    const junky = envelope('location.update', { fix: { ...fix, junk: 'x'.repeat(1000) } });
    expect(validateWsClientMessage(junky)).toMatchObject({ ok: true, mutating: true });
  });
  it('accepts catch.confirm with an empty qrToken (manual confirm)', () => {
    // The client sends qrToken: '' on a manual confirm (websocket.ts).
    const manual = envelope('catch.confirm', { catchId: 'c1', qrToken: '', manualConfirm: true });
    expect(validateWsClientMessage(manual)).toMatchObject({ ok: true });
  });
  it('accepts catch.dispute and leave exactly as the client sends them (reason carried)', () => {
    expect(validateWsClientMessage(envelope('catch.dispute', { catchId: 'c1', reason: 'Disputed by the Runner — host to review in person.' }))).toMatchObject({ ok: true });
    expect(validateWsClientMessage(envelope('leave', { reason: null }))).toMatchObject({ ok: true });
  });
  it('accepts snapshot.request with lastServerSeq, hello with protocol 1', () => {
    expect(validateWsClientMessage(envelope('snapshot.request', { lastServerSeq: 4 }))).toMatchObject({ ok: true, mutating: false });
    expect(validateWsClientMessage(envelope('hello', { protocolVersion: 1, clientVersion: 'pakdam-web/0.1.0', lastServerSeq: 0 }))).toMatchObject({ ok: true });
  });
  it('rejects a message without v: 1 and leaves unknown types to the DO', () => {
    expect(validateWsClientMessage({ type: 'location.update', payload: { fix } })).toMatchObject({ ok: false });
    expect(validateWsClientMessage(envelope('no.such.type', {}))).toMatchObject({ ok: true, mutating: false });
  });
});

describe('HTTP request bodies (real Zod, strict)', () => {
  it('rejects a create-room body with an unknown key', () => {
    const body = {
      displayName: 'Host', kind: 'guest',
      config: {
        mode: 'classic', teamAssignment: 'random', maxPlayers: 30, hunterCount: 1,
        durationSeconds: 600, headStartSeconds: 60, pingIntervalSeconds: 180,
        zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 300,
        catchConfirmationRequired: true,
        zone: { boundary: [{ lat: 23.35, lng: 85.32 }], shrinkPhases: [] },
        safeAreas: [], noGoAreas: [], selectedHunterIds: [], hostOnSiteConfirmed: true,
      },
      ageGatePassed: true, surpriseField: 1,
    };
    expect(createRoomBody.safeParse(body).success).toBe(false);
    expect(joinBody.safeParse({ displayName: 'Guest', kind: 'guest', roomCode: 'ABC123' }).success).toBe(true);
    expect(ticketBody.safeParse({ playerId, reconnectToken: 'tok' }).success).toBe(true);
  });
});

describe('stored game events (real Zod)', () => {
  it('round-trips a LOCATION_UPDATED event and rejects an unknown key', () => {
    const event = {
      id: '33333333-3333-4333-8333-333333333333',
      timestamp: '2026-11-17T10:00:00.000Z', roomId, actorId: playerId,
      type: 'LOCATION_UPDATED',
      payload: { fix: { lat: 23.352, lng: 85.321, accuracyMeters: 8, at: '2026-11-17T10:00:00.000Z' }, quality: 'good' },
    };
    expect(parseGameEvent(event).type).toBe('LOCATION_UPDATED');
    expect(safeParseGameEvent({ ...event, payload: { ...event.payload, extra: 1 } }).success).toBe(false);
  });
});
