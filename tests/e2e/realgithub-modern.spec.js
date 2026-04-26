// Tests against the modern Primer-React PR layout (PullRequestDiffsList).
// Captured from a real PR rendered in the new UI.
//
// Re-capture: node tests/fixtures/_capture.mjs <PR_URL> --profile

import { test, expect } from '@playwright/test';
import { launchWithExtension } from './harness.js';

const BROWSER = process.env.PRDP_BROWSER || 'chromium';

let env;

test.beforeAll(async ({}, info) => {
  const browserName = info.project.metadata?.browser || BROWSER;
  env = await launchWithExtension({ browserName, fixture: 'realGithubModern' });
});

test.afterAll(async () => { await env?.cleanup(); });

async function gotoPR() {
  const page = env.context.pages()[0] ?? await env.context.newPage();
  await page.goto(`${env.baseURL}/vaatun/vantage/pull/1621/changes`);
  await page.waitForSelector('#prdp-root', { timeout: 10000 });
  // modern layout has lazy-loaded headers, give injection a moment
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  return page;
}

test.describe('modern GitHub markup (PullRequestDiffsList)', () => {
  test('detects modern diff entry', async () => {
    const page = await gotoPR();
    const items = page.locator('#prdp-list .prdp-item');
    // The captured fixture preserves only the rendered diff entries (React
    // virtualizes the rest). At least one must parse, with no placeholders.
    expect(await items.count()).toBeGreaterThan(0);
  });

  test('extracts file path from data-file-path / hash-link (no placeholders)', async () => {
    const page = await gotoPR();
    const paths = await page.locator('#prdp-list .prdp-item .prdp-path').allTextContents();
    expect(paths.length).toBeGreaterThan(0);
    // No `file-N` placeholder names
    expect(paths.some(p => /^file-\d+$/.test(p))).toBe(false);
    // Captured fixture is from vaatun/vantage#1621 — first rendered file is
    // apps/vantage/e2e/policy-view.spec.ts
    expect(paths.some(p => /apps\/vantage|policy-view\.spec/i.test(p))).toBe(true);
  });

  test('parses per-file +/- counts from sr-only "Lines changed" text', async () => {
    const page = await gotoPR();
    const stats = await page.locator('#prdp-list .prdp-item .prdp-stats').allInnerTexts();
    expect(stats.length).toBeGreaterThan(0);
    // The bug we just fixed: every file showed +0 -0 because the modern
    // layout parser missed the sr-only "Lines changed: N additions" text.
    const nonZero = stats.filter(s => !/^\+\s*0\s*-\s*0$/.test(s.replace(/\s+/g, ''))).length;
    expect(nonZero).toBeGreaterThan(0);
  });

  test('inline approve button injected on modern DiffFileHeader', async () => {
    const page = await gotoPR();
    const inline = page.locator('.prdp-inline-approve');
    expect(await inline.count()).toBeGreaterThan(0);
    await expect(inline.first()).toContainText('Approve');
  });

  test('approval flow works on modern markup', async () => {
    const page = await gotoPR();
    const inline = page.locator('.prdp-inline-approve').first();
    await inline.click();
    await expect(inline).toHaveClass(/approved/);
    await expect(inline).toContainText('Approved');
  });
});
