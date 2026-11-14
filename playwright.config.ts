import { defineConfig, devices } from '@playwright/test';

const external = process.env.PLAYWRIGHT_BASE_URL;
export default defineConfig({
  testDir: './tests/ui',
  timeout: 30000,
  expect: { timeout: 7000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: external || 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1100 } },
    },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: external
    ? undefined
    : {
        command: 'npm run mock',
        url: 'http://127.0.0.1:4173/healthz',
        reuseExistingServer: !process.env.CI,
        timeout: 15000,
      },
});
