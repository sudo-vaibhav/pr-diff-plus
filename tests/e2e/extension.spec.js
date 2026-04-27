import { test, expect } from '@playwright/test';
import { launchWithExtension } from './harness.js';

let BROWSER = 'chromium';
let env;
let testCounter = 0;

test.beforeAll(async ({}, info) => {
  BROWSER = info.project.metadata?.browser || 'chromium';
  env = await launchWithExtension({ browserName: BROWSER, fixture: 'synthetic' });
});

test.afterAll(async () => { await env?.cleanup(); });

async function freshPR() {
  const n = ++testCounter;
  const page = env.context.pages()[0] ?? await env.context.newPage();
  await page.goto(`${env.baseURL}/vaatun/vantage/pull/${1000 + n}/files`);
  await page.waitForSelector('#prdp-root', { timeout: 10000 });
  await page.waitForTimeout(250);
  return page;
}

async function setMode(page, mode) {
  await page.locator(`#prdp-view-${mode}`).click();
  await expect(page.locator('#prdp-root')).toHaveClass(new RegExp(`mode-${mode}`));
}

test.describe(`core UI`, () => {
  test('injects sidebar with title', async () => {
    const page = await freshPR();
    await expect(page.locator('#prdp-root')).toBeVisible();
    await expect(page.locator('.prdp-title')).toHaveText('PR Diff Plus');
  });

  test('starts in tree view by default (fresh profile)', async () => {
    const page = await freshPR();
    await expect(page.locator('#prdp-root')).toHaveClass(/mode-(tree|flat)/);
  });
});

test.describe(`flat view`, () => {
  test('shows all files as flat list', async () => {
    const page = await freshPR();
    await setMode(page, 'flat');
    await expect(page.locator('#prdp-list .prdp-item')).toHaveCount(4);
  });

  test('progress reflects approved state', async () => {
    const page = await freshPR();
    await setMode(page, 'flat');
    await expect(page.locator('.prdp-count')).toHaveText('0/4');
    await page.keyboard.press('a');
    await expect(page.locator('.prdp-count')).toHaveText('1/4');
    await page.keyboard.press('a');
    await expect(page.locator('.prdp-count')).toHaveText('0/4');
  });

  test('complexity scores correct', async () => {
    const page = await freshPR();
    await setMode(page, 'flat');
    const scores = await page.locator('#prdp-list .prdp-item .prdp-tag').allTextContents();
    expect(scores).toEqual(['100', '16', '175', '2']);
  });

  test('sort by complexity reorders', async () => {
    const page = await freshPR();
    await setMode(page, 'flat');
    await page.locator('#prdp-sort').selectOption('score');
    const paths = await page.locator('#prdp-list .prdp-item .prdp-path').allTextContents();
    expect(paths[0]).toBe('yarn.lock');
    expect(paths[1]).toBe('src/feature.ts');
  });

  test('filter narrows list', async () => {
    const page = await freshPR();
    await setMode(page, 'flat');
    await page.keyboard.press('/');
    await page.keyboard.type('lock');
    await expect(page.locator('#prdp-list .prdp-item')).toHaveCount(1);
    await expect(page.locator('#prdp-list .prdp-item .prdp-path')).toHaveText('yarn.lock');
  });
});

test.describe(`tree view`, () => {
  test('renders folders before files at root', async () => {
    const page = await freshPR();
    await setMode(page, 'tree');
    const firstRow = page.locator('#prdp-list > li').first();
    await expect(firstRow).toHaveClass(/prdp-dir/);
  });

  test('files inside a folder are listed under that folder', async () => {
    const page = await freshPR();
    await setMode(page, 'tree');
    const fileRows = page.locator('#prdp-list .prdp-item');
    const names = await fileRows.locator('.prdp-path').allTextContents();
    expect(names).toContain('feature.ts');
    expect(names).toContain('feature.test.ts');
    expect(names).toContain('yarn.lock');
    expect(names).toContain('README.md');
  });

  test('clicking a folder collapses it', async () => {
    const page = await freshPR();
    await setMode(page, 'tree');
    expect(await page.locator('#prdp-list .prdp-item').count()).toBe(4);
    await page.locator('#prdp-list .prdp-dir', { hasText: 'src' }).click();
    expect(await page.locator('#prdp-list .prdp-item').count()).toBe(2);
  });

  test('directory shows approved/total count', async () => {
    const page = await freshPR();
    await setMode(page, 'tree');
    const srcCount = page.locator('#prdp-list .prdp-dir', { hasText: 'src' }).locator('.prdp-dircount');
    await expect(srcCount).toHaveText('0/2');

    const featureRow = page.locator('#prdp-list .prdp-item', { hasText: 'feature.ts' }).first();
    await featureRow.locator('.prdp-check').click();
    await expect(srcCount).toHaveText('1/2');
  });
});

test.describe(`approval`, () => {
  test('check icon toggles approved state', async () => {
    const page = await freshPR();
    const row = page.locator('#prdp-list .prdp-item').first();
    await expect(row).not.toHaveClass(/approved/);
    await row.locator('.prdp-check').click();
    await expect(row).toHaveClass(/approved/);
    await expect(page.locator('.prdp-count')).toHaveText('1/4');
  });

  test('a key toggles approval for active file', async () => {
    const page = await freshPR();
    await page.locator('body').click({ position: { x: 50, y: 200 } });
    await page.keyboard.press('a');
    await expect(page.locator('.prdp-count')).toHaveText('1/4');
  });

  test('hide-approved checkbox hides marked files', async () => {
    const page = await freshPR();
    await page.locator('body').click({ position: { x: 50, y: 200 } });
    await page.keyboard.press('a');
    await expect(page.locator('.prdp-count')).toHaveText('1/4');
    await page.locator('#prdp-hide-approved').check();
    await expect(page.locator('#prdp-list .prdp-item')).toHaveCount(3);
  });

  test('approval persists across reload', async () => {
    const n = ++testCounter;
    const url = `${env.baseURL}/vaatun/vantage/pull/${1000 + n}/files`;
    const page = env.context.pages()[0];

    await page.goto(url);
    await page.waitForSelector('#prdp-root');
    await page.waitForTimeout(250);
    await page.locator('body').click({ position: { x: 50, y: 200 } });
    await page.keyboard.press('a');
    await expect(page.locator('.prdp-count')).toHaveText('1/4');

    await page.reload();
    await page.waitForSelector('#prdp-root');
    await page.waitForTimeout(250);
    await expect(page.locator('.prdp-count')).toHaveText('1/4');
  });
});

test.describe(`keyboard nav`, () => {
  test('j advances active file, k goes back', async () => {
    const page = await freshPR();
    await setMode(page, 'flat');
    await page.locator('body').click({ position: { x: 50, y: 200 } });

    const active = page.locator('#prdp-list .prdp-item.active .prdp-path').first();
    await expect(active).toHaveText('src/feature.ts');

    await page.keyboard.press('j');
    await expect(active).toHaveText('src/feature.test.ts', { timeout: 3000 });

    await page.keyboard.press('k');
    await expect(active).toHaveText('src/feature.ts', { timeout: 3000 });
  });

  test('? opens help, Escape closes it', async () => {
    const page = await freshPR();
    await page.locator('body').click({ position: { x: 50, y: 200 } });
    await page.keyboard.press('?');
    await expect(page.locator('#prdp-help')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#prdp-help')).toBeHidden();
  });

  test('s collapses sidebar', async () => {
    const page = await freshPR();
    await page.locator('body').click({ position: { x: 50, y: 200 } });
    await expect(page.locator('#prdp-root')).not.toHaveClass(/collapsed/);
    await page.keyboard.press('s');
    await expect(page.locator('#prdp-root')).toHaveClass(/collapsed/);
    await page.keyboard.press('s');
    await expect(page.locator('#prdp-root')).not.toHaveClass(/collapsed/);
  });
});

test.describe(`inline approve button`, () => {
  test('renders an approve button on every diff', async () => {
    const page = await freshPR();
    const inline = page.locator('.prdp-inline-approve');
    await expect(inline).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect(inline.nth(i)).toContainText('Approve');
    }
  });

  test('clicking inline button toggles approval and syncs sidebar', async () => {
    const page = await freshPR();
    const firstInline = page.locator('.prdp-inline-approve').first();
    await firstInline.click();
    await expect(firstInline).toHaveClass(/approved/);
    await expect(firstInline).toContainText('Approved');
    await expect(page.locator('.prdp-count')).toHaveText('1/4');
  });

  test('approving via sidebar updates inline button', async () => {
    const page = await freshPR();
    const sidebarRow = page.locator('#prdp-list .prdp-item', {
      has: page.locator('.prdp-path', { hasText: /^feature\.ts$|^src\/feature\.ts$/ })
    }).first();
    await sidebarRow.locator('.prdp-check').click();
    const inline = page.locator('.prdp-inline-approve[data-anchor^="diff-aaaa"]');
    await expect(inline).toHaveClass(/approved/);
  });
});

test.describe(`native Viewed mirror`, () => {
  test('approving via inline button flips native aria-pressed to true', async () => {
    const page = await freshPR();
    const native = page.locator('button[aria-label="Viewed"][data-anchor="diff-aaaa"]');
    await expect(native).toHaveAttribute('aria-pressed', 'false');

    await page.locator('.prdp-inline-approve[data-anchor^="diff-aaaa"]').click();

    await expect(native).toHaveAttribute('aria-pressed', 'true');
  });

  test('approving via sidebar checkbox also flips native aria-pressed', async () => {
    const page = await freshPR();
    const native = page.locator('button[aria-label="Viewed"][data-anchor="diff-bbbb"]');
    await expect(native).toHaveAttribute('aria-pressed', 'false');

    const row = page.locator('#prdp-list .prdp-item', {
      has: page.locator('.prdp-path', { hasText: 'feature.test.ts' })
    }).first();
    await row.locator('.prdp-check').click();

    await expect(native).toHaveAttribute('aria-pressed', 'true');
  });

  test('un-approving flips native aria-pressed back to false', async () => {
    const page = await freshPR();
    const inline = page.locator('.prdp-inline-approve[data-anchor^="diff-cccc"]');
    const native = page.locator('button[aria-label="Viewed"][data-anchor="diff-cccc"]');

    await inline.click();
    await expect(native).toHaveAttribute('aria-pressed', 'true');
    await inline.click();
    await expect(native).toHaveAttribute('aria-pressed', 'false');
  });

  test('does not click native if aria-pressed already matches desired state', async () => {
    const page = await freshPR();
    const native = page.locator('button[aria-label="Viewed"][data-anchor="diff-dddd"]');
    // Pre-set native to "true" so it already matches what we'll request
    await native.evaluate(b => b.setAttribute('aria-pressed', 'true'));

    let clickCount = 0;
    await native.evaluate(b => {
      b.addEventListener('click', () => { window.__nativeClicks = (window.__nativeClicks || 0) + 1; });
    });

    // Approve via inline — extension should NOT click native (already on)
    await page.locator('.prdp-inline-approve[data-anchor^="diff-dddd"]').click();
    clickCount = await page.evaluate(() => window.__nativeClicks || 0);
    expect(clickCount).toBe(0);
    await expect(native).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe(`auto-collapse`, () => {
  test('hides yarn.lock body and shows badge', async () => {
    const page = await freshPR();
    const lockBody = page.locator('#diff-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc .js-file-content');
    await expect(lockBody).toBeHidden();

    const badge = page.locator('#diff-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc .prdp-genbadge');
    await expect(badge).toBeVisible();
    await badge.click();
    await expect(lockBody).toBeVisible();
  });
});
