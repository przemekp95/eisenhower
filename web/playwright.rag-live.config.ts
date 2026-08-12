import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL;
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR;

if (!baseURL || !outputDir) {
  throw new Error('PLAYWRIGHT_BASE_URL and PLAYWRIGHT_OUTPUT_DIR are required');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/grounded-rag.live.manual.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir,
  reporter: [['list']],
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1200 } },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
  use: {
    baseURL,
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
});
