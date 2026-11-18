// PHASE 1 SUITE (separate file — v2.1 Issue 4 fix).
// These tests are NOT Phase 0 acceptance criteria. They are placeholders
// for native background-location behaviour, to be run only in Phase 1.
// They are deliberately skipped here so a Phase 0 run never treats an
// impossible background requirement as a test to pass or fail.
import test from 'node:test';
test('Phase 1: background GPS with screen locked (native only)', { skip: true }, () => {});
test('Phase 1: locked-phone SOS delivery (native only)', { skip: true }, () => {});
test('Phase 1: background location on iOS/Android (native only)', { skip: true }, () => {});
