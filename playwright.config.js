import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1400, height: 900 },
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium-extension',
      use: { headless: true },
      metadata: { browser: 'chromium' }
    }
    // Firefox extension testing is not currently runnable via Playwright's
    // bundled Firefox (it doesn't honor xpinstall.signatures.required=false
    // for profile-side installs, and exposes no Marionette addon API). For
    // Firefox compatibility we rely on `web-ext lint` (npm run lint:firefox)
    // plus manual smoke testing via about:debugging "Load Temporary Add-on".
    // Harness code in tests/e2e/harness.js retains the firefox path for when
    // upstream Playwright adds proper extension support.
  ]
});
