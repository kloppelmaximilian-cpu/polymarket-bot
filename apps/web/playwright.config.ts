import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke tests against a running dashboard (API + web):
 *   WEB_URL=http://localhost:3000 pnpm test:e2e
 * PLAYWRIGHT_CHROMIUM_PATH points at an existing Chromium when the bundled
 * browser download is not available (e.g. in CI images or sandboxes).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    ...(process.env.WEB_BASIC_AUTH_USER ? { httpCredentials: { username: process.env.WEB_BASIC_AUTH_USER, password: process.env.WEB_BASIC_AUTH_PASSWORD ?? '' } } : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1600, height: 1000 },
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
      },
    },
  ],
});
