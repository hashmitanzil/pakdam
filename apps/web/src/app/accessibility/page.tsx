import type { Metadata } from 'next';
import PageHero from '@/components/landing/PageHero';
import AccessibilitySettings from '@/components/accessibility/AccessibilitySettings';

export const metadata: Metadata = {
  title: 'Accessibility — Pakdam accessibility statement and settings',
  description:
    'Pakdam accessibility statement (WCAG 2.2 AA target) and display settings for this device: large text and high contrast.',
  alternates: { canonical: '/accessibility' },
};

export default function AccessibilityPage() {
  return (
    <div className="subpage">
      <PageHero
        kicker="Accessibility"
        title="Play it your way."
        lede="Two settings, on this device, in plain words. Turn one on and the whole site changes with it — no account needed."
      />

      <section className="journey-card" aria-labelledby="what-each-does">
        <h2 id="what-each-does">What each setting does</h2>
        <ul>
          <li>
            <strong>Large text</strong> — makes the words across the site
            bigger, so they are easier to read without zooming in and out.
          </li>
          <li>
            <strong>High contrast</strong> — sharpens the difference between
            words and the background, so text stands out more.
          </li>
        </ul>
        <p>
          Your choices are saved on this device and apply across the whole
          site, on every page. They stay saved between visits. Teams are
          always shown by shape and letter as well as colour — Hunters
          ◆ H, Runners ▲ R — so nothing important is told by colour alone.
        </p>
      </section>

      <h2>Zoom, motion, and the map</h2>
      <ul>
        <li>
          <strong>Zoom works.</strong> The pages are built to stay usable at
          130% zoom — buttons stay big enough to tap, and nothing important
          disappears off the side of the screen.
        </li>
        <li>
          <strong>Reduced motion is respected.</strong> If your phone or
          browser asks for less movement, Pakdam keeps animation to a
          minimum. There is no separate switch for this — your device setting
          is the switch.
        </li>
        <li>
          <strong>The map is visual — so there are words too.</strong> The
          map itself is not fully accessible. The same information is also
          given as words: hot/cold hints, &ldquo;last reported X min
          ago&rdquo;, the hunt board, and the compass-radar view. You can
          play without reading the map.
        </li>
        <li>
          <strong>Buttons are big on purpose.</strong> The main buttons are
          thumb-sized, at the bottom of the screen where your thumb already
          is, and every control has a label a screen reader can read.
        </li>
      </ul>

      <AccessibilitySettings />
    </div>
  );
}
