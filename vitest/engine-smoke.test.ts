import { describe, expect, it } from 'vitest';
import { balancedHunterCount } from '../packages/engine/src/roles.js';
import { polygonFullyInside, randomOffsetShrinkBoundary } from '../packages/engine/src/zone.js';

/**
 * Engine smoke tests under Vitest (TS source directly — no dist build
 * needed). The full engine suite stays `node --test`
 * (`packages/engine/test/*.test.ts`); these are the Vitest-side smoke
 * checks that the runner itself works against real engine code.
 */
describe('balancedHunterCount ladder (founder, 2026-11-17)', () => {
  it.each([
    [3, 1], [4, 1], [5, 2], [8, 2], [9, 3], [16, 3], [17, 4], [24, 4], [25, 5], [30, 5],
  ])('%i players -> %i hunters', (players, hunters) => {
    expect(balancedHunterCount(players)).toBe(hunters);
  });
});

describe('next zone is smaller and fully inside (PUBG/BGMI-style)', () => {
  const circle = [
    { lat: 23.35, lng: 85.32 }, { lat: 23.35, lng: 85.33 },
    { lat: 23.36, lng: 85.33 }, { lat: 23.36, lng: 85.32 },
  ];
  it('a 75% shrink sits fully inside the current zone', () => {
    const next = randomOffsetShrinkBoundary(circle, 0.75, () => 0.5);
    expect(polygonFullyInside(next, circle)).toBe(true);
  });
});
