import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: false,
    viewport: { width: 1400, height: 900 },
    trace: 'on-first-retry'
  },
  projects: [
    { name: 'chromium-extension' }
  ]
});
