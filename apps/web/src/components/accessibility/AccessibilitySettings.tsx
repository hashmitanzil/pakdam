'use client';
import { useEffect, useState } from 'react';

/** Accessibility settings, persisted on this device (demo).
 *  localStorage keys: pakdam.a11y.large-text, pakdam.a11y.high-contrast.
 *  Settings apply on this page immediately and site-wide: the
 *  layout-level AccessibilityProvider re-applies them from storage
 *  on every page and navigation.
 *
 *  NOTE (2026-11-17, one-map decision): there is NO map-style
 *  setting any more — the map is one bundled offline map (Doranda +
 *  Hinoo), with no style switcher. The High contrast checkbox is a
 *  page-level treatment, not a map provider, and it stays.
 *
 *  NOTE (2026-11-18, simplification): there is NO theme setting
 *  any more — Pakdam has one dark theme, properly executed
 *  everywhere, with no light theme and no toggle. Hunters ◆ H solid
 *  / Runners ▲ R hatched is the team encoding in that single theme:
 *  shape + letter + words, never colour alone. */
const KEYS = {
  largeText: 'pakdam.a11y.large-text',
  highContrast: 'pakdam.a11y.high-contrast',
} as const;

export default function AccessibilitySettings() {
  const [largeText, setLargeText] = useState(false);
  const [highContrast, setHighContrast] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLargeText(localStorage.getItem(KEYS.largeText) === '1');
    setHighContrast(localStorage.getItem(KEYS.highContrast) === '1');
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const root = document.documentElement;
    root.style.fontSize = largeText ? '112.5%' : '';
    root.style.filter = highContrast ? 'contrast(1.25)' : '';
    localStorage.setItem(KEYS.largeText, largeText ? '1' : '0');
    localStorage.setItem(KEYS.highContrast, highContrast ? '1' : '0');
  }, [largeText, highContrast, loaded]);

  return (
    <div>
      <h1>Accessibility</h1>
      <p>Pakdam targets WCAG 2.2 AA: normal text 4.5:1, large and non-text content 3:1 — across the website and the app. This statement is version 1, dated 16 November 2026, and is reviewed whenever the design system changes.</p>

      <h2>Your settings</h2>
      {!loaded ? <p>Loading your settings…</p> : (
        <div className="card">
          <p><label><input type="checkbox" checked={largeText} onChange={(e) => setLargeText(e.target.checked)} /> Large text</label></p>
          <p><label><input type="checkbox" checked={highContrast} onChange={(e) => setHighContrast(e.target.checked)} /> High contrast</label></p>
          <p className="small">Settings are saved on this device and persist between visits. They apply on this page immediately and on every page — the layout provider re-applies them whenever you navigate.</p>
        </div>
      )}

      <h2>What is provided</h2>
      <ul>
        <li>Large-text setting (above)</li>
        <li>Reduced-motion is respected where the browser requests it</li>
        <li>Keyboard operability and screen-reader labels on interactive controls</li>
      </ul>

      <h2>Known limitations</h2>
      <p>The map is a visual surface and is not itself fully accessible. The non-visual equivalents are the compass-radar view and text alternatives: hot/cold tiers, &ldquo;last reported X min ago&rdquo;, and the hunt board. We do not claim the map itself is fully accessible.</p>

      <h2>Report a barrier</h2>
      <p>If something is hard or impossible to use, tell us via the <a href="/contact">contact form</a> (topic: Accessibility) or file a <a href="/grievance">grievance</a>. We acknowledge reports and fix them through the normal review process — no fix timeline is promised here.</p>
    </div>
  );
}
