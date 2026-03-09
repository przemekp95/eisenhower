import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const webDir = __dirname;
const backendDir = path.resolve(webDir, '../backend-node');
const frontendUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173';
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? 'http://127.0.0.1:3101';

export default defineConfig({
  testDir: './e2e',
  testIgnore: '**/*.manual.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  outputDir: './output/playwright/test-results',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './output/playwright/report' }],
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
  webServer: [
    {
      command: 'npm run dev:e2e',
      cwd: backendDir,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '3101',
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: `${apiUrl}/health`,
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
      cwd: webDir,
      env: {
        ...process.env,
        VITE_AI_API_URL: 'http://127.0.0.1:8100',
        VITE_API_URL: apiUrl,
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: frontendUrl,
    },
  ],
});
