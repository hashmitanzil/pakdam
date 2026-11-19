/**
 * @pakdam/engine — the pure game-logic package for Pakdam.
 *
 * Pure functions + state transitions only. No I/O, no Worker/DO imports,
 * no web imports; imports only @pakdam/shared. The Durable Object, the
 * demo store and the web app all build on these rules — the DO enforces
 * them authoritatively, the others mirror them.
 */
export * from './state-machine.js';
export * from './modes.js';
export * from './roles.js';
export * from './zone.js';
export * from './pings.js';
export * from './catch.js';
export * from './safety.js';
export * from './suspension.js';
export * from './scoring.js';
export * from './snapshot.js';

/** Geo types re-exported for web/worker callers (defined in @pakdam/shared). */
export type { GeoPoint, GeoPolygon } from '@pakdam/shared';
