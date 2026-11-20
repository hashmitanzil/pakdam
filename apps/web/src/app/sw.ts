/// <reference lib="webworker" />
import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { NetworkOnly, Serwist } from 'serwist';

// PWA service worker (Serwist). Offline shell only — map tiles are Ola live
// tiles and are out of scope for offline caching in this rebuild.
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

/**
 * Ola Maps must NEVER go through the service worker's runtime cache.
 * Serwist's `defaultCache` has a NetworkFirst rule matching `*.json` —
 * and Ola's style + TileJSON URLs all end in `.json`
 * (`.../styles/default-dark-standard/style.json`,
 * `.../data/planet.json`, ...). A cached/stale copy of those, or a
 * service-worker-forwarded fetch that does not carry the page's Origin,
 * is exactly the kind of thing that makes the map fail with Ola's
 * "Domain is not allowed" (Ola's domain check reads the Origin header,
 * not the Referer — proven by direct tests against the live key: any
 * request carrying `Origin: https://pakdam.vercel.app` returns 200,
 * any request without it returns 403, whatever the Referer is). So Ola
 * requests are NetworkOnly and are matched FIRST (routes match in
 * order), before any defaultCache rule can claim them. Tiles, sprites
 * and glyphs are not `.json` but they belong to the same live API, so
 * the whole olamaps.io host is excluded, not just the JSON URLs.
 */
const runtimeCaching = [
  {
    matcher: /^https:\/\/([a-z0-9-]+\.)?olamaps\.io\//i,
    handler: new NetworkOnly(),
  },
  ...defaultCache,
];

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching,
});

serwist.addEventListeners();
