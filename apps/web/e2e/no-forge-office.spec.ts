// No-Forge-Office e2e — TEXT/DOM assertions only, no screenshots.
// The Forge Office tab/section is being removed from the game UI:
// no Forge board, no Mission 001, no correction register, no release
// gates in any player-facing tab. These specs pin that removal —
// they fail if any Forge Office surface comes back on any key route.
// (Source grep 2026-11-17: zero "forge" matches in apps/web/src
// outside comments, and zero matches for the other phrases.)
import { test, expect } from '@playwright/test';

const KEY_ROUTES = [
  '/',
 '/create', '/join', '/host',
  '/leaderboards',
];

const FORGE_PATTERNS = [
  /Forge Office/i,
  /Forge board/i,
  /Mission 001/i,
  /correction register/i,
  /release gates/i,
];

test('no Forge Office surface on any key player-facing route', async ({ page }) => {
  for (const route of KEY_ROUTES) {
    await page.goto(route);
    await expect(page.getByRole('heading').first()).toBeVisible();
    const bodyText = await page.locator('body').innerText();
    for (const pattern of FORGE_PATTERNS) {
      expect(bodyText, `${route}: must not mention ${pattern}`).not.toMatch(pattern);
    }
    // The bare word must not appear either — no tab, section or link.
    expect(bodyText, `${route}: must not mention Forge at all`).not.toMatch(/Forge/i);
    await expect(page.getByRole('link', { name: /Forge/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Forge/i })).toHaveCount(0);
  }
});

test('top bar has no Forge entry, and there is no footer at all', async ({ page }) => {
  await page.goto('/');
  // The real navigation is present and Forge-free: brand + Host a
  // Game CTA only (strip-down 2026-11-19 — the info-page links are gone).
  await expect(page.getByRole('link', { name: /Host a Game/ }).first()).toBeVisible();
  const navLinks = await page.locator('header nav a, header a').allInnerTexts();
  expect(navLinks.join(' | ')).not.toMatch(/Forge/i);
  // The footer was removed in the strip-down: no footer element, no
  // footer links at all — so no Forge entry can hide there either.
  await expect(page.locator('footer')).toHaveCount(0);
});
