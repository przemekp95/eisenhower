import { defineConfig, devices } from '@playwright/test';

const frontendUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.manual.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 90_000,
  expect: {
    timeout: 20_000,
  },
  outputDir: './output/playwright/manual-test-results',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './output/playwright/manual-report' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: frontendUrl,
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1440, height: 1200 },
  },
});
