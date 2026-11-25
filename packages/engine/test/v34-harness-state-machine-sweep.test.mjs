import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const {
  MATCH_PHASES,
  MATCH_PHASE_TRANSITIONS,
  TERMINAL_PHASES,
  transition,
  transitionForEvent,
  transitionOrThrow,
  canTransition,
  isTerminalPhase,
  isLivePhase,
  isPlayPhase,
} = await import('../src/state-machine.ts');

// v34 HARNESS (Arjun, QA) — approach (g): state-machine sweep.
//
// Every one of the 12 phases x 12 targets (144 edges) plus every named
// event from every phase. Each edge must either succeed exactly when
// the table allows it, or refuse with INVALID_STATE — never throw,
// never hang, never silently apply. This is the sweep the v32 lesson
// demands: v32's unit pins passed while CI still failed, because no
// test had enumerated the machine. A builder change to the table that
// breaks an edge fails HERE first, with the edge named.

const ALL_EVENTS = [
  'room-created',
  'start-requested',
  'countdown-complete',
  'head-start-elapsed',
  'match-end',
  'resolve-complete',
  'cancel',
  'abandon',
  'expire',
  'pause',
  'resume',
];

test('v34 harness sweep: all 144 (from, to) edges agree with the transition table', () => {
  assert.equal(MATCH_PHASES.length, 12, 'the machine has exactly 12 phases');
  let legal = 0;
  let illegal = 0;
  for (const from of MATCH_PHASES) {
    for (const to of MATCH_PHASES) {
      const expected = from !== to && (MATCH_PHASE_TRANSITIONS[from]).includes(to);
      const r = transition(from, to);
      if (expected) {
        legal += 1;
        assert.equal(r.ok, true, `${from} -> ${to} must succeed`);
        assert.equal(r.phase, to);
      } else {
        illegal += 1;
        assert.equal(r.ok, false, `${from} -> ${to} must refuse`);
        assert.equal(r.code, 'INVALID_STATE', `${from} -> ${to} refuses with INVALID_STATE`);
        assert.equal(typeof r.reason, 'string');
        assert.ok(r.reason.length > 0, 'a refusal always carries a plain-words reason');
      }
    }
  }
  // The table as written: count the legal edges independently so a
  // table edit that silently adds/removes an edge fails loudly here.
  const tableLegal = MATCH_PHASES.reduce(
    (n, from) => n + MATCH_PHASE_TRANSITIONS[from].length,
    0,
  );
  assert.equal(legal, tableLegal);
  assert.equal(legal + illegal, 144);
});

test('v34 harness sweep: a transition to the same phase is an error, never a silent no-op', () => {
  for (const phase of MATCH_PHASES) {
    const r = transition(phase, phase);
    assert.equal(r.ok, false, `${phase} -> ${phase} must refuse`);
    assert.equal(r.code, 'INVALID_STATE');
    assert.match(r.reason, /Already in/);
  }
});

test('v34 harness sweep: terminal phases have no outgoing edge, live phases are exactly HEAD_START/ACTIVE/SAFETY_PAUSED', () => {
  assert.deepEqual([...TERMINAL_PHASES].sort(), ['ABANDONED', 'CANCELLED', 'COMPLETED', 'EXPIRED']);
  for (const phase of TERMINAL_PHASES) {
    assert.equal(MATCH_PHASE_TRANSITIONS[phase].length, 0, `${phase} must have no outgoing edge`);
    assert.equal(isTerminalPhase(phase), true);
    for (const to of MATCH_PHASES) {
      assert.equal(canTransition(phase, to), false, `nothing leaves ${phase}`);
    }
  }
  for (const phase of MATCH_PHASES) {
    assert.equal(isLivePhase(phase), phase === 'HEAD_START' || phase === 'ACTIVE' || phase === 'SAFETY_PAUSED');
    assert.equal(isPlayPhase(phase), phase === 'HEAD_START' || phase === 'ACTIVE');
  }
});

test('v34 harness sweep: every named event from every phase either works or refuses with INVALID_STATE — never throws', () => {
  for (const from of MATCH_PHASES) {
    for (const event of ALL_EVENTS) {
      let r;
      assert.doesNotThrow(() => {
        // 'resume' needs a paused-from; without it the refusal is the
        // specified one, not a crash.
        r = transitionForEvent(from, event);
      }, `${event} from ${from} must never throw`);
      assert.ok(r.ok === true || (r.ok === false && r.code === 'INVALID_STATE'),
        `${event} from ${from} must be ok or INVALID_STATE, got ${JSON.stringify(r)}`);
    }
  }
});

test('v34 harness sweep: resume resolves through pausedFrom and never hard-codes ACTIVE', () => {
  // From SAFETY_PAUSED, resume returns to the phase paused from.
  assert.deepEqual(transitionForEvent('SAFETY_PAUSED', 'resume', 'HEAD_START'), { ok: true, phase: 'HEAD_START' });
  assert.deepEqual(transitionForEvent('SAFETY_PAUSED', 'resume', 'ACTIVE'), { ok: true, phase: 'ACTIVE' });
  // Resume to a phase with no edge from SAFETY_PAUSED refuses.
  const bad = transitionForEvent('SAFETY_PAUSED', 'resume', 'LOBBY');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_STATE');
  // Resume with no paused-from refuses with a reason, never throws.
  const missing = transitionForEvent('SAFETY_PAUSED', 'resume');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'INVALID_STATE');
  assert.match(missing.reason, /no paused-from/);
  const nullFrom = transitionForEvent('SAFETY_PAUSED', 'resume', null);
  assert.equal(nullFrom.ok, false);
  assert.equal(nullFrom.code, 'INVALID_STATE');
});

test('v34 harness sweep: the happy path walks LOBBY -> READY_CHECK -> COUNTDOWN -> HEAD_START -> ACTIVE -> RESOLVING -> COMPLETED', () => {
  // The event map has no event for READY_CHECK -> COUNTDOWN: the DO
  // walks that edge directly in startMatch (three transitionOrThrow
  // calls), and 'countdown-complete' targets HEAD_START. Pin the real
  // walk, not an invented event.
  let phase = 'LOBBY';
  const started = transitionForEvent(phase, 'start-requested');
  assert.equal(started.ok, true, JSON.stringify(started));
  phase = started.phase;
  const countedDown = transition(phase, 'COUNTDOWN');
  assert.equal(countedDown.ok, true, JSON.stringify(countedDown));
  phase = countedDown.phase;
  for (const event of ['countdown-complete', 'head-start-elapsed', 'match-end', 'resolve-complete']) {
    const r = transitionForEvent(phase, event);
    assert.equal(r.ok, true, `${event} from ${phase} must succeed: ${JSON.stringify(r)}`);
    phase = r.phase;
  }
  assert.equal(phase, 'COMPLETED');
  assert.equal(isTerminalPhase(phase), true);
});

test('v34 harness sweep: pause/resume round-trips from both live phases, and pause after end refuses', () => {
  for (const live of ['HEAD_START', 'ACTIVE']) {
    const paused = transitionForEvent(live, 'pause');
    assert.equal(paused.ok, true, `pause from ${live} must succeed`);
    assert.equal(paused.phase, 'SAFETY_PAUSED');
    const resumed = transitionForEvent('SAFETY_PAUSED', 'resume', live);
    assert.equal(resumed.ok, true, `resume to ${live} must succeed`);
    assert.equal(resumed.phase, live);
  }
  // Out-of-order: pause after the match ended, resume when never paused.
  assert.equal(transitionForEvent('COMPLETED', 'pause').ok, false);
  assert.equal(transitionForEvent('ACTIVE', 'resume', 'HEAD_START').ok, false,
    'resume from ACTIVE (never paused) must refuse — there is no SAFETY_PAUSED edge out of ACTIVE to HEAD_START via resume');
  assert.equal(transitionForEvent('LOBBY', 'pause').ok, false);
  assert.equal(transitionForEvent('LOBBY', 'match-end').ok, false, 'a lobby cannot end a match');
  assert.equal(transitionForEvent('DRAFT', 'start-requested').ok, false);
  assert.equal(transitionForEvent('CANCELLED', 'cancel').ok, false);
});

test('v34 harness sweep: transitionOrThrow throws INVALID_STATE (with .code) on illegal edges only', () => {
  assert.equal(transitionOrThrow('LOBBY', 'READY_CHECK'), 'READY_CHECK');
  assert.throws(
    () => transitionOrThrow('LOBBY', 'ACTIVE'),
    (e) => e instanceof Error && e.code === 'INVALID_STATE',
  );
  assert.throws(
    () => transitionOrThrow('COMPLETED', 'LOBBY'),
    (e) => e instanceof Error && e.code === 'INVALID_STATE',
  );
});

test('v34 harness sweep: cancel/abandon/expire reach exactly their terminal phases', () => {
  assert.deepEqual(transitionForEvent('LOBBY', 'cancel'), { ok: true, phase: 'CANCELLED' });
  assert.deepEqual(transitionForEvent('ACTIVE', 'cancel'), { ok: true, phase: 'CANCELLED' });
  assert.deepEqual(transitionForEvent('ACTIVE', 'abandon'), { ok: true, phase: 'ABANDONED' });
  assert.deepEqual(transitionForEvent('LOBBY', 'expire'), { ok: true, phase: 'EXPIRED' });
  // Abandon is NOT an edge out of the lobby; expire is NOT an edge out of a live match.
  assert.equal(transitionForEvent('LOBBY', 'abandon').ok, false);
  assert.equal(transitionForEvent('ACTIVE', 'expire').ok, false);
  assert.equal(transitionForEvent('HEAD_START', 'abandon').ok, false);
});
