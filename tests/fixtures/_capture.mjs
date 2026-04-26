// One-off helper: navigates Playwright Chromium to a public PR /files page and
// snapshots the rendered HTML to tests/fixtures/real-github-pr.html.
//
// Re-run when GitHub's markup changes:
//   node tests/fixtures/_capture.mjs [PR_URL]
//
// Strips scripts, link tags, and inline base64 to keep the fixture small and
// safe to load offline. Keeps the diff structure (copilot-diff-entry,
// .file.js-file, .diffstat, file-header, file-info) which is all the
// extension reads.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const URL = process.argv[2] || 'https://github.com/facebook/react/pull/28000/files';
const OUT = join(__dirname, 'real-github-pr.html');

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('copilot-diff-entry, .file.js-file', { timeout: 15000 });

// Scroll to force lazy load of all diffs in view
for (let y = 0; y < 6; y++) {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight));
  await page.waitForTimeout(300);
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(800);

const html = await page.evaluate(() => {
  // Snapshot a stripped version: keep diff containers, drop scripts/tracking.
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('script, link, meta, style[data-styled-components], iframe').forEach(n => n.remove());
  clone.querySelectorAll('[data-react-helmet], [data-hyperaction]').forEach(n => n.remove());
  return '<!doctype html>\n' + clone.outerHTML;
});

writeFileSync(OUT, html);
console.log(`Captured ${(html.length / 1024).toFixed(1)} KB → ${OUT}`);

await browser.close();
