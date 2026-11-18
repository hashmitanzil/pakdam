# pakdam-web — Phase 0 PWA (demo mode)

Next.js 15.5 App Router, TypeScript strict, MapLibre GL JS, Serwist PWA
(`@serwist/next`, webpack path — see repo docs/DECISIONS.md).

## Run
```bash
cd pakdam-app
npm install
npm run dev --workspace=pakdam-web   # http://localhost:3000
```
Demo mode: the game engine runs locally in the browser (see
`src/lib/demo-store.ts`); rooms persist to localStorage WITHOUT coordinates.
Production realtime uses `src/lib/websocket.ts` against `workers/` — not
wired in this demo. Tile source in the demo is CARTO basemap (demo only);
the production tile provider is OPEN.
