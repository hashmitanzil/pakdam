/** HNT-116 simulation harness entry (16-player single room, demo engine).
 *  Run: npx tsx scripts/simulate-match.ts — or after build, node with the
 *  compiled engine. This script is a smoke harness, not a load test. */
import { assignRoles, transition, resolveOutcome } from '../packages/engine/src/index.js';
const players = Array.from({ length: 16 }, (_, i) => ({
  playerId: `p${i}`, roomId: 'sim', kind: 'guest' as const, displayName: `Player ${i}`,
  isHost: i === 0, matchRole: null, team: null, reconnectTokenHash: 'sim',
  joinedAt: new Date().toISOString(), leftAt: null, connectionState: 'connected' as const,
  lastFixAt: null, locationQuality: 'unknown' as const, isReady: true,
  briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0,
}));
const assigned = assignRoles(players, 2);
console.log('players:', assigned.length, 'hunters:', assigned.filter((p) => p.matchRole === 'hunter').length, 'runners:', assigned.filter((p) => p.matchRole === 'runner').length);
console.log('phase DRAFT->LOBBY:', transition('DRAFT', 'LOBBY'));
console.log('outcome, 1 runner caught, time expired:', JSON.stringify(resolveOutcome(assigned, ['p2'], true)));
