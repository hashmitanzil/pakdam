// GPS-mock probe — run against a local `next start` on :3105.
// Prints what the page actually shows at each step; exits 0.
import { chromium } from 'playwright';

const BASE = 'http://localhost:3105';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sample(page, label) {
  const body = await page.evaluate(() => document.body.innerText);
  const picks = ['Best fix so far', 'GPS is off by', 'GPS accuracy', 'Zone centre:', 'Location found', 'Location unavailable', 'Finding your location'];
  const found = picks.filter((p) => body.includes(p)).map((p) => {
    const i = body.indexOf(p);
    return body.slice(i, i + 90).replace(/\n/g, ' | ');
  });
  console.log(`--- ${label} ---`);
  console.log(found.length ? found.join('\n') : '(none of the GPS lines present)');
}

const browser = await chromium.launch({
  // The headless-shell binary SIGTRAPs at startup on this VM; the full
  // Chromium build launches fine.
  executablePath: '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
try {
  // Probe 1: coarse 5 km fix — refining readout + watchdog rejection.
  {
    const context = await browser.newContext({ geolocation: { latitude: 23.36, longitude: 85.33, accuracy: 5000 }, permissions: ['geolocation'] });
    const page = await context.newPage();
    await page.goto(BASE + '/create');
    await page.getByLabel(/codename/i).fill('Probe Host');
    await sleep(3000);
    await sample(page, 'coarse 5km @3s');
    await sleep(7000);
    await sample(page, 'coarse 5km @10s');
    await sleep(12000);
    await sample(page, 'coarse 5km @22s (watchdog should have fired)');
    // Now the fix refines to 8 m — does watchPosition deliver it?
    await context.setGeolocation({ latitude: 23.36, longitude: 85.33, accuracy: 8 });
    await sleep(5000);
    await sample(page, 'after setGeolocation accuracy 8 @5s');
    await sleep(5000);
    await sample(page, 'after setGeolocation accuracy 8 @10s');
    await context.close();
  }
  // Probe 2: no accuracy specified — what does the mock report?
  {
    const context = await browser.newContext({ geolocation: { latitude: 23.36, longitude: 85.33 }, permissions: ['geolocation'] });
    const page = await context.newPage();
    await page.goto(BASE + '/create');
    await page.getByLabel(/codename/i).fill('Probe Host 2');
    await page.getByRole('button', { name: /Use my location/ }).click();
    await sleep(5000);
    await sample(page, 'default accuracy, after Use my location @5s');
    await context.close();
  }
  // Probe 3: denied.
  {
    const context = await browser.newContext({ permissions: [] });
    const page = await context.newPage();
    await page.goto(BASE + '/create');
    await page.getByLabel(/codename/i).fill('Probe Host 3');
    await page.getByRole('button', { name: /Use my location/ }).click();
    await sleep(5000);
    await sample(page, 'denied, after Use my location @5s');
    await context.close();
  }
} finally {
  await browser.close();
}
console.log('PROBE DONE');
