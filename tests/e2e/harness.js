// Shared launcher for cross-browser extension e2e.
// - Chromium: --load-extension + --disable-extensions-except
// - Firefox:  zip extension into XPI, place in profile/extensions/<gecko-id>.xpi.
//             Playwright's bundled Firefox accepts unsigned XPIs.
// Both use a local Node http server serving fixture HTML at GitHub-shaped paths.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { chromium, firefox } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const SRC_EXT = join(REPO, 'extension');

export const FIXTURES = {
  synthetic: join(REPO, 'tests', 'fixtures', 'pr-page.html'),
  realGithub: join(REPO, 'tests', 'fixtures', 'real-github-pr.html'),
  realGithubModern: join(REPO, 'tests', 'fixtures', 'real-github-pr-modern.html')
};

function buildTestExtensionDir() {
  const extDir = mkdtempSync(join(tmpdir(), 'prdp-ext-'));
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

  return { extDir, geckoId: manifest.browser_specific_settings?.gecko?.id || 'pr-diff-plus@local' };
}

function buildXpi(extDir, outPath) {
  if (existsSync(outPath)) rmSync(outPath);
  execSync(`cd "${extDir}" && zip -X -r -q "${outPath}" .`);
  return outPath;
}

function installXpiIntoProfile(xpi, profileDir, geckoId) {
  const extRoot = join(profileDir, 'extensions');
  mkdirSync(extRoot, { recursive: true });
  copyFileSync(xpi, join(extRoot, geckoId + '.xpi'));
}

function installUnpackedIntoProfile(extSrc, profileDir, geckoId) {
  const dest = join(profileDir, 'extensions', geckoId);
  mkdirSync(dest, { recursive: true });
  // Recursive copy via cp -R (macOS/Linux). Windows would need a JS impl.
  execSync(`cp -R "${extSrc}/" "${dest}/"`);
}

function startFixtureServer(fixturePath) {
  const html = readFileSync(fixturePath, 'utf8');
  const server = http.createServer((req, res) => {
    if (/^\/[^/]+\/[^/]+\/pull\/\d+\/(files|changes)/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseURL: `http://localhost:${port}` });
    });
  });
}

export async function launchWithExtension({ browserName, fixture }) {
  const { extDir, geckoId } = buildTestExtensionDir();
  const userDir = mkdtempSync(join(tmpdir(), 'prdp-ud-' + browserName + '-'));
  const fixturePath = FIXTURES[fixture] ?? FIXTURES.synthetic;
  const { server, baseURL } = await startFixtureServer(fixturePath);

  let context;
  if (browserName === 'firefox') {
    // Unpacked install is more reliable than XPI in Playwright's Firefox build.
    installUnpackedIntoProfile(extDir, userDir, geckoId);
    context = await firefox.launchPersistentContext(userDir, {
      headless: true,
      firefoxUserPrefs: {
        'xpinstall.signatures.required': false,
        'xpinstall.signatures.dev-root': true,
        'extensions.autoDisableScopes': 0,
        'extensions.enabledScopes': 15,
        'extensions.startupScanScopes': 15,
        'extensions.installDistroAddons': false,
        'extensions.update.enabled': false,
        'extensions.experiments.enabled': true,
        'extensions.legacy.enabled': true,
        'extensions.webextensions.warnings-as-errors': false
      }
    });
    // Try installing via Marionette's addons API as a fallback.
    try {
      // playwright doesn't expose addons.install directly, but the profile
      // copy *should* be loaded on startup. Wait long enough for the addon
      // manager to initialize.
      const page = context.pages()[0] ?? await context.newPage();
      await page.waitForTimeout(1500);
    } catch {}
  } else {
    context = await chromium.launchPersistentContext(userDir, {
      headless: true,
      channel: 'chromium',
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        '--no-first-run'
      ]
    });
  }

  return {
    context,
    baseURL,
    extDir,
    server,
    async cleanup() {
      try { await context.close(); } catch {}
      try { server.close(); } catch {}
    }
  };
}
