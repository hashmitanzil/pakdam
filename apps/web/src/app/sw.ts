/// <reference lib="webworker" />
import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { Serwist } from 'serwist';
// Service worker caches the app SHELL ONLY (Serwist precache).
// It NEVER caches private game/location/staff data, and NEVER queues
// competitive actions for offline replay.
declare const self: ServiceWorkerGlobalScope & SerwistGlobalConfig;
const serwist = new Serwist({
  precacheEntries: (self as unknown as { __SW_MANIFEST: PrecacheEntry[] }).__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
});
serwist.addEventListeners();
