// Sub-suite: tests against a real GitHub PR /files HTML snapshot captured by
// tests/fixtures/_capture.mjs. Validates the extension still parses the
// current GitHub markup (selectors, diffstat format, anchors). Re-capture the
// fixture if GitHub ships layout changes — these tests will tell you.

import { test, expect } from '@playwright/test';
import { launchWithExtension } from './harness.js';

const BROWSER = process.env.PRDP_BROWSER || 'chromium';

let env;

test.beforeAll(async () => {
  env = await launchWithExtension({ browserName: BROWSER, fixture: 'realGithub' });
});

test.afterAll(async () => { await env?.cleanup(); });

async function gotoRealPR() {
  const page = env.context.pages()[0] ?? await env.context.newPage();
  await page.goto(`${env.baseURL}/facebook/react/pull/28000/files`);
  await page.waitForSelector('#prdp-root', { timeout: 10000 });
  await page.waitForTimeout(400);
  return page;
}

test.describe(`real GitHub markup`, () => {
  test('detects diff entries from real markup', async () => {
    const page = await gotoRealPR();
    const items = page.locator('#prdp-list .prdp-item');
    expect(await items.count()).toBeGreaterThanOrEqual(1);
  });

  test('extracts file path correctly', async () => {
    const page = await gotoRealPR();
    const paths = await page.locator('#prdp-list .prdp-item .prdp-path').allTextContents();
    // The captured PR (facebook/react#28000) modifies one test file
    expect(paths.some(p => p.includes('ReactFreshMultipleRenderer-test.internal.js'))).toBe(true);
  });

  test('parses additions/deletions from diffstat', async () => {
    const page = await gotoRealPR();
    const stats = await page.locator('#prdp-list .prdp-item .prdp-stats').first().innerText();
    expect(stats).toMatch(/\+\d+/);
    expect(stats).toMatch(/-\d+/);
    expect(stats).not.toMatch(/\+0\b.*-0\b/); // not zero/zero — real PR has churn
  });

  test('classifies the test file (low weight) and assigns a score', async () => {
    const page = await gotoRealPR();
    const tag = page.locator('#prdp-list .prdp-item .prdp-tag').first();
    const score = parseInt(await tag.textContent(), 10);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThan(50);
    const item = page.locator('#prdp-list .prdp-item').first();
    await expect(item).toHaveClass(/test/); // .test.internal.js → test file
  });

  test('inline approve button injected next to real diff header', async () => {
    const page = await gotoRealPR();
    const inline = page.locator('.prdp-inline-approve');
    expect(await inline.count()).toBeGreaterThanOrEqual(1);
    await expect(inline.first()).toContainText('Approve');
  });

  test('approval flow works end-to-end on real markup', async () => {
    const page = await gotoRealPR();
    const inline = page.locator('.prdp-inline-approve').first();
    await inline.click();
    await expect(inline).toHaveClass(/approved/);
    await expect(inline).toContainText('Approved');
    const total = await page.locator('#prdp-list .prdp-item').count();
    await expect(page.locator('.prdp-count')).toHaveText(`1/${total}`);
  });

  test('hide-approved removes approved file from sidebar', async () => {
    const page = await gotoRealPR();
    const total = await page.locator('#prdp-list .prdp-item').count();

    // Ensure first file ends up approved regardless of state from previous test
    const inline = page.locator('.prdp-inline-approve').first();
    if (!(await inline.evaluate(n => n.classList.contains('approved')))) {
      await inline.click();
    }
    await expect(inline).toHaveClass(/approved/);

    await page.locator('#prdp-hide-approved').check();
    await expect(page.locator('#prdp-list .prdp-item')).toHaveCount(total - 1);
  });
});
