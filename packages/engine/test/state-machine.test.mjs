import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const {
  transition,
  canTransition,
  isTerminalPhase,
  transitionForEvent,
  isLivePhase,
  isPlayPhase,
} = await import('../src/state-machine.ts');

test('transition: a legal edge succeeds', () => {
  assert.deepEqual(transition('LOBBY', 'READY_CHECK'), {
    ok: true,
    phase: 'READY_CHECK',
  });
  assert.deepEqual(transition('HEAD_START', 'ACTIVE'), { ok: true, phase: 'ACTIVE' });
  assert.deepEqual(transition('RESOLVING', 'COMPLETED'), {
    ok: true,
    phase: 'COMPLETED',
  });
});

test('transition: an illegal edge is rejected with INVALID_STATE', () => {
  const r = transition('LOBBY', 'ACTIVE');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_STATE');
  assert.match(r.reason, /Cannot move from LOBBY to ACTIVE/);
});

test('transition: the same phase is an error, never a silent no-op', () => {
  const r = transition('ACTIVE', 'ACTIVE');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_STATE');
  assert.match(r.reason, /Already in ACTIVE/);
});

test('transition: nothing leaves a terminal phase', () => {
  assert.equal(transition('COMPLETED', 'LOBBY').ok, false);
  assert.equal(transition('CANCELLED', 'LOBBY').ok, false);
  assert.equal(transition('ABANDONED', 'ACTIVE').ok, false);
  assert.equal(transition('EXPIRED', 'LOBBY').ok, false);
});

test('canTransition and isTerminalPhase agree with the table', () => {
  assert.equal(canTransition('HEAD_START', 'ACTIVE'), true);
  assert.equal(canTransition('HEAD_START', 'COMPLETED'), false);
  assert.equal(canTransition('SAFETY_PAUSED', 'HEAD_START'), true);
  assert.equal(isTerminalPhase('COMPLETED'), true);
  assert.equal(isTerminalPhase('CANCELLED'), true);
  assert.equal(isTerminalPhase('ABANDONED'), true);
  assert.equal(isTerminalPhase('EXPIRED'), true);
  assert.equal(isTerminalPhase('ACTIVE'), false);
  assert.equal(isTerminalPhase('LOBBY'), false);
});

test('transitionForEvent: the happy path walks DRAFT → LOBBY → … → COMPLETED', () => {
  assert.deepEqual(transitionForEvent('DRAFT', 'room-created'), {
    ok: true,
    phase: 'LOBBY',
  });
  assert.deepEqual(transitionForEvent('LOBBY', 'start-requested'), {
    ok: true,
    phase: 'READY_CHECK',
  });
  assert.deepEqual(transitionForEvent('COUNTDOWN', 'countdown-complete'), {
    ok: true,
    phase: 'HEAD_START',
  });
  assert.deepEqual(transitionForEvent('HEAD_START', 'head-start-elapsed'), {
    ok: true,
    phase: 'ACTIVE',
  });
  assert.deepEqual(transitionForEvent('ACTIVE', 'match-end'), {
    ok: true,
    phase: 'RESOLVING',
  });
  assert.deepEqual(transitionForEvent('RESOLVING', 'resolve-complete'), {
    ok: true,
    phase: 'COMPLETED',
  });
});

test('transitionForEvent: resume without pausedFrom is rejected, with it returns to that phase', () => {
  const noFrom = transitionForEvent('SAFETY_PAUSED', 'resume');
  assert.equal(noFrom.ok, false);
  assert.equal(noFrom.code, 'INVALID_STATE');
  assert.deepEqual(transitionForEvent('SAFETY_PAUSED', 'resume', 'ACTIVE'), {
    ok: true,
    phase: 'ACTIVE',
  });
  // A pause taken during HEAD_START resumes into HEAD_START, not ACTIVE.
  assert.deepEqual(transitionForEvent('SAFETY_PAUSED', 'resume', 'HEAD_START'), {
    ok: true,
    phase: 'HEAD_START',
  });
});

test('isLivePhase: the clock runs in HEAD_START, ACTIVE and SAFETY_PAUSED only', () => {
  assert.equal(isLivePhase('HEAD_START'), true);
  assert.equal(isLivePhase('ACTIVE'), true);
  assert.equal(isLivePhase('SAFETY_PAUSED'), true);
  assert.equal(isLivePhase('LOBBY'), false);
  assert.equal(isLivePhase('COMPLETED'), false);
});

test('isPlayPhase: HEAD_START and ACTIVE, but not SAFETY_PAUSED', () => {
  assert.equal(isPlayPhase('HEAD_START'), true);
  assert.equal(isPlayPhase('ACTIVE'), true);
  assert.equal(isPlayPhase('SAFETY_PAUSED'), false);
  assert.equal(isPlayPhase('LOBBY'), false);
});
