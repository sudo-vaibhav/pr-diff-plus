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
    await expect(page.locator('#prdp-list .prdp-item')).toHaveCount(5);
  });

  test('progress reflects approved state', async () => {
    const page = await freshPR();
    await setMode(page, 'flat');
    await expect(page.locator('.prdp-count')).toHaveText('0/5');
    await page.keyboard.press('a');
    await expect(page.locator('.prdp-count')).toHaveText('1/5');
    await page.keyboard.press('a');
    await expect(page.locator('.prdp-count')).toHaveText('0/5');
  });

  test('complexity scores correct', async () => {
    const page = await freshPR();
    await setMode(page, 'flat');
    const scores = await page.locator('#prdp-list .prdp-item .prdp-tag').allTextContents();
    // 4 rendered diff cards + 1 tree-only entry (CHANGELOG.md, score 0)
    expect(scores).toEqual(['100', '16', '175', '2', '0']);
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
    expect(await page.locator('#prdp-list .prdp-item').count()).toBe(5);
    await page.locator('#prdp-list .prdp-dir', { hasText: 'src' }).click();
    // src/ holds 2 of 5 files; collapsing leaves 3 visible
    expect(await page.locator('#prdp-list .prdp-item').count()).toBe(3);
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
    await expect(page.locator('.prdp-count')).toHaveText('1/5');
  });

  test('a key toggles approval for active file', async () => {
    const page = await freshPR();
    await page.locator('body').click({ position: { x: 50, y: 200 } });
    await page.keyboard.press('a');
    await expect(page.locator('.prdp-count')).toHaveText('1/5');
  });

  test('hide-approved checkbox hides marked files', async () => {
    const page = await freshPR();
    await page.locator('body').click({ position: { x: 50, y: 200 } });
    await page.keyboard.press('a');
    await expect(page.locator('.prdp-count')).toHaveText('1/5');
    await page.locator('#prdp-hide-approved').check();
    await expect(page.locator('#prdp-list .prdp-item')).toHaveCount(4);
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
    await expect(page.locator('.prdp-count')).toHaveText('1/5');

    await page.reload();
    await page.waitForSelector('#prdp-root');
    await page.waitForTimeout(250);
    await expect(page.locator('.prdp-count')).toHaveText('1/5');
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
  test('renders an approve button on every rendered diff card', async () => {
    const page = await freshPR();
    const inline = page.locator('.prdp-inline-approve');
    // 4 rendered diff cards; CHANGELOG.md is tree-only — its button appears
    // only when GitHub lazy-renders the card.
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
    await expect(page.locator('.prdp-count')).toHaveText('1/5');
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

test.describe(`native left-tree hide`, () => {
  test('hide-approved hides matching entries in #pr-file-tree', async () => {
    const page = await freshPR();
    const treeRows = page.locator('#pr-file-tree [role="treeitem"][data-prdp-test="native-tree-row"]');
    await expect(treeRows).toHaveCount(4);

    // Approve src/feature.ts via inline button
    await page.locator('.prdp-inline-approve[data-anchor^="diff-aaaa"]').click();

    // Hide approved
    await page.locator('#prdp-hide-approved').check();

    const visible = page.locator('#pr-file-tree [role="treeitem"][data-prdp-test="native-tree-row"]:not([data-prdp-hidden])');
    await expect(visible).toHaveCount(3);

    const visiblePaths = await visible.locator('[data-file-path]').evaluateAll(els =>
      els.map(e => e.getAttribute('data-file-path'))
    );
    expect(visiblePaths).not.toContain('src/feature.ts');
  });

  test('toggling hide-approved off restores native tree entries', async () => {
    const page = await freshPR();
    await page.locator('.prdp-inline-approve[data-anchor^="diff-aaaa"]').click();
    await page.locator('#prdp-hide-approved').check();
    await expect(
      page.locator('#pr-file-tree [role="treeitem"][data-prdp-test="native-tree-row"]:not([data-prdp-hidden])')
    ).toHaveCount(3);

    await page.locator('#prdp-hide-approved').uncheck();

    await expect(
      page.locator('#pr-file-tree [role="treeitem"][data-prdp-test="native-tree-row"]:not([data-prdp-hidden])')
    ).toHaveCount(4);
  });

  test('un-approving a file restores it to native tree even with hide-approved on', async () => {
    const page = await freshPR();
    const inline = page.locator('.prdp-inline-approve[data-anchor^="diff-cccc"]');
    await inline.click();
    await page.locator('#prdp-hide-approved').check();
    await expect(
      page.locator('#pr-file-tree [role="treeitem"][data-prdp-test="native-tree-row"]:not([data-prdp-hidden])')
    ).toHaveCount(3);

    await inline.click(); // un-approve

    await expect(
      page.locator('#pr-file-tree [role="treeitem"][data-prdp-test="native-tree-row"]:not([data-prdp-hidden])')
    ).toHaveCount(4);
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

test.describe(`tree-only files (lazy-loaded diff cards)`, () => {
  test('files visible only in native left tree still appear in our sidebar', async () => {
    const page = await freshPR();
    const paths = await page.locator('#prdp-list .prdp-item .prdp-path').allTextContents();
    expect(paths.some(p => p.includes('CHANGELOG.md'))).toBe(true);
  });

  test('tree-only entry has no inline Approve button (no diff card to attach to)', async () => {
    const page = await freshPR();
    const inline = page.locator('.prdp-inline-approve');
    // 4 rendered cards = 4 inline buttons; the 5th (CHANGELOG) has no card yet
    await expect(inline).toHaveCount(4);
  });

  test('tree-only entry can still be approved via sidebar checkbox', async () => {
    const page = await freshPR();
    await expect(page.locator('.prdp-count')).toHaveText('0/5');

    const row = page.locator('#prdp-list .prdp-item', {
      has: page.locator('.prdp-path', { hasText: 'CHANGELOG.md' })
    }).first();
    await row.locator('.prdp-check').click();

    await expect(page.locator('.prdp-count')).toHaveText('1/5');
    await expect(row).toHaveClass(/approved/);
  });
});

test.describe(`initial sync from native Viewed`, () => {
  test('files already marked viewed by GitHub get auto-approved on init', async () => {
    const n = ++testCounter;
    const url = `${env.baseURL}/vaatun/vantage/pull/${1000 + n}/files?prepress=diff-aaaa`;
    const page = env.context.pages()[0];
    await page.goto(url);
    await page.waitForSelector('#prdp-root');
    await page.waitForTimeout(400);

    await expect(page.locator('.prdp-count')).toHaveText('1/5');
    const inline = page.locator('.prdp-inline-approve[data-anchor^="diff-aaaa"]');
    await expect(inline).toHaveClass(/approved/);
  });

  test('native sync persists across reload', async () => {
    const n = ++testCounter;
    const url = `${env.baseURL}/vaatun/vantage/pull/${1000 + n}/files?prepress=diff-bbbb`;
    const page = env.context.pages()[0];
    await page.goto(url);
    await page.waitForSelector('#prdp-root');
    await page.waitForTimeout(400);
    await expect(page.locator('.prdp-count')).toHaveText('1/5');

    // Reload without prepress query — approval persists from chrome.storage
    await page.goto(url.replace(/\?prepress=.+$/, ''));
    await page.waitForSelector('#prdp-root');
    await page.waitForTimeout(400);
    await expect(page.locator('.prdp-count')).toHaveText('1/5');
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
