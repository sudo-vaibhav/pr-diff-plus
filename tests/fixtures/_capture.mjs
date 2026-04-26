// Captures a real GitHub PR /files page as a fixture. Two output paths:
//   - tests/fixtures/real-github-pr.html         (legacy copilot-diff-entry layout)
//   - tests/fixtures/real-github-pr-modern.html  (new Primer-React PullRequestDiffsList layout)
//
// Detects which layout the captured page uses and writes to the right file.
//
// Usage:
//   node tests/fixtures/_capture.mjs [PR_URL]
//   node tests/fixtures/_capture.mjs [PR_URL] --profile  (use /tmp/prdp-debug-profile, keeps logged-in cookies)
//
// The new layout is currently rolled out only to some orgs/accounts; capturing
// a private PR you can see on the new UI requires the --profile flag plus a
// pre-logged-in profile dir.

import { chromium } from 'playwright';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const URL = process.argv[2] || 'https://github.com/facebook/react/pull/28000/files';
const USE_PROFILE = process.argv.includes('--profile');
const PROFILE_DIR = '/tmp/prdp-debug-profile';

const LEGACY_OUT = join(__dirname, 'real-github-pr.html');
const MODERN_OUT = join(__dirname, 'real-github-pr-modern.html');

let browser, ctx, page;
if (USE_PROFILE) {
  if (!existsSync(PROFILE_DIR)) {
    console.error(`No profile at ${PROFILE_DIR}. Launch /tmp/prdp-debug.mjs first and log in.`);
    process.exit(1);
  }
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1400, height: 900 }
  });
  page = ctx.pages()[0] ?? await ctx.newPage();
} else {
  browser = await chromium.launch({ headless: true });
  ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await ctx.newPage();
}

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector(
  'copilot-diff-entry, .file.js-file, [class*="PullRequestDiffsList-module__diffEntry"], [data-file-path]',
  { timeout: 15000 }
);

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

// Detect layout from the captured HTML and write to the matching file.
const isModern = /PullRequestDiffsList-module__diffEntry/.test(html) ||
                 (/data-file-path/.test(html) && !/copilot-diff-entry/.test(html));
const OUT = isModern ? MODERN_OUT : LEGACY_OUT;
const layoutLabel = isModern ? 'modern (PullRequestDiffsList)' : 'legacy (copilot-diff-entry)';

writeFileSync(OUT, html);
console.log(`Captured ${(html.length / 1024).toFixed(1)} KB ${layoutLabel} → ${OUT}`);

if (browser) await browser.close();
else await ctx.close();
