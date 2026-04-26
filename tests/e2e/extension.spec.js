import { test, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const SRC_EXT = join(REPO, 'extension');
const FIXTURE = join(REPO, 'tests', 'fixtures', 'pr-page.html');

let context;
let server;
let baseURL;
let extDir;
let testCounter = 0;

test.beforeAll(async () => {
  extDir = mkdtempSync(join(tmpdir(), 'prdp-ext-'));
  mkdirSync(join(extDir, 'src'), { recursive: true });
  copyFileSync(join(SRC_EXT, 'src', 'lib.js'), join(extDir, 'src', 'lib.js'));
  copyFileSync(join(SRC_EXT, 'src', 'content.js'), join(extDir, 'src', 'content.js'));
  copyFileSync(join(SRC_EXT, 'src', 'styles.css'), join(extDir, 'src', 'styles.css'));
  copyFileSync(join(SRC_EXT, 'popup.html'), join(extDir, 'popup.html'));
  copyFileSync(join(SRC_EXT, 'popup.js'), join(extDir, 'popup.js'));

  const manifest = JSON.parse(readFileSync(join(SRC_EXT, 'manifest.json'), 'utf8'));
  manifest.content_scripts[0].matches = ['<all_urls>'];
  manifest.host_permissions = ['<all_urls>'];
  writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const html = readFileSync(FIXTURE, 'utf8');
  server = http.createServer((req, res) => {
    if (/^\/[^/]+\/[^/]+\/pull\/\d+\/files/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  baseURL = `http://localhost:${port}`;

  const userDir = mkdtempSync(join(tmpdir(), 'prdp-userdata-'));
  context = await chromium.launchPersistentContext(userDir, {
    headless: false,
    channel: 'chromium',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-first-run'
    ]
  });
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
});

async function freshPR() {
  const n = ++testCounter;
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`${baseURL}/vaatun/vantage/pull/${1000 + n}/files`);
  await page.waitForSelector('#prdp-root', { timeout: 8000 });
  await page.waitForTimeout(200);
  return page;
}

async function setMode(page, mode) {
  await page.locator(`#prdp-view-${mode}`).click();
  await expect(page.locator('#prdp-root')).toHaveClass(new RegExp(`mode-${mode}`));
}

test.describe('core UI', () => {
  test('injects sidebar with title', async () => {
    const page = await freshPR();
    await expect(page.locator('#prdp-root')).toBeVisible();
    await expect(page.locator('.prdp-title')).toHaveText('PR Diff Plus');
  });

  test('starts in tree view by default', async () => {
    const page = await freshPR();
    await expect(page.locator('#prdp-root')).toHaveClass(/mode-tree/);
    await expect(page.locator('#prdp-view-tree')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('flat view', () => {
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

test.describe('tree view', () => {
  test('renders folders before files at root', async () => {
    const page = await freshPR();
    await setMode(page, 'tree');
    const firstRow = page.locator('#prdp-list > li').first();
    await expect(firstRow).toHaveClass(/prdp-dir/);
  });

  test('files inside a folder are listed under that folder', async () => {
    const page = await freshPR();
    await setMode(page, 'tree');
    // src dir contains feature.ts and feature.test.ts
    const dir = page.locator('#prdp-list .prdp-dir', { hasText: 'src' });
    await expect(dir).toBeVisible();
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
    const before = await page.locator('#prdp-list .prdp-item').count();
    expect(before).toBe(4);

    await page.locator('#prdp-list .prdp-dir', { hasText: 'src' }).click();
    const after = await page.locator('#prdp-list .prdp-item').count();
    expect(after).toBe(2); // only yarn.lock + README.md remain
  });

  test('directory shows approved/total count', async () => {
    const page = await freshPR();
    await setMode(page, 'tree');
    const srcCount = page.locator('#prdp-list .prdp-dir', { hasText: 'src' }).locator('.prdp-dircount');
    await expect(srcCount).toHaveText('0/2');

    // approve one file in src by clicking its check
    const featureRow = page.locator('#prdp-list .prdp-item', { hasText: 'feature.ts' }).first();
    await featureRow.locator('.prdp-check').click();
    await expect(srcCount).toHaveText('1/2');
  });
});

test.describe('approval', () => {
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
    await page.keyboard.press('a');
    await expect(page.locator('.prdp-count')).toHaveText('1/4');
  });

  test('hide-approved checkbox hides marked files', async () => {
    const page = await freshPR();
    await page.keyboard.press('a');
    await expect(page.locator('.prdp-count')).toHaveText('1/4');
    await page.locator('#prdp-hide-approved').check();
    await expect(page.locator('#prdp-list .prdp-item')).toHaveCount(3);
  });

  test('h key toggles hide-approved', async () => {
    const page = await freshPR();
    await page.keyboard.press('a');
    await page.keyboard.press('h');
    await expect(page.locator('#prdp-hide-approved')).toBeChecked();
    await expect(page.locator('#prdp-list .prdp-item')).toHaveCount(3);
    await page.keyboard.press('h');
    await expect(page.locator('#prdp-hide-approved')).not.toBeChecked();
  });

  test('approval persists across reload', async () => {
    const n = ++testCounter;
    const url = `${baseURL}/vaatun/vantage/pull/${1000 + n}/files`;
    const page = context.pages()[0];

    await page.goto(url);
    await page.waitForSelector('#prdp-root');
    await page.waitForTimeout(200);
    await page.keyboard.press('a');
    await expect(page.locator('.prdp-count')).toHaveText('1/4');

    await page.reload();
    await page.waitForSelector('#prdp-root');
    await page.waitForTimeout(200);
    await expect(page.locator('.prdp-count')).toHaveText('1/4');
  });
});

test.describe('keyboard nav', () => {
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
    await page.keyboard.press('?');
    await expect(page.locator('#prdp-help')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#prdp-help')).toBeHidden();
  });

  test('s collapses sidebar', async () => {
    const page = await freshPR();
    await expect(page.locator('#prdp-root')).not.toHaveClass(/collapsed/);
    await page.keyboard.press('s');
    await expect(page.locator('#prdp-root')).toHaveClass(/collapsed/);
    await page.keyboard.press('s');
    await expect(page.locator('#prdp-root')).not.toHaveClass(/collapsed/);
  });

  test('t toggles tree/flat view', async () => {
    const page = await freshPR();
    await setMode(page, 'tree'); // baseline — viewMode is persisted globally
    await page.locator('body').click({ position: { x: 50, y: 200 } });

    await page.keyboard.press('t');
    await expect(page.locator('#prdp-root')).toHaveClass(/mode-flat/);
    await page.keyboard.press('t');
    await expect(page.locator('#prdp-root')).toHaveClass(/mode-tree/);
  });
});

test.describe('inline approve button', () => {
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
    await expect(firstInline).not.toHaveClass(/approved/);
    await expect(firstInline).toContainText('Approve');

    await firstInline.click();

    await expect(firstInline).toHaveClass(/approved/);
    await expect(firstInline).toContainText('Approved');
    await expect(page.locator('.prdp-count')).toHaveText('1/4');

    // sidebar row checkbox also reflects approval
    const sidebarRow = page.locator('#prdp-list .prdp-item', { hasText: 'feature.ts' }).first();
    await expect(sidebarRow).toHaveClass(/approved/);
  });

  test('approving via sidebar updates inline button', async () => {
    const page = await freshPR();
    // approve feature.ts via its sidebar row (find by path to be order-independent)
    const sidebarRow = page.locator('#prdp-list .prdp-item', {
      has: page.locator('.prdp-path', { hasText: /^feature\.ts$|^src\/feature\.ts$/ })
    }).first();
    await sidebarRow.locator('.prdp-check').click();

    const inline = page.locator('.prdp-inline-approve[data-anchor^="diff-aaaa"]');
    await expect(inline).toHaveClass(/approved/);
    await expect(inline).toContainText('Approved');
  });
});

test.describe('auto-collapse', () => {
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
