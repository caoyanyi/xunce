import { resolveChromiumPath } from './server/browser.ts';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4319',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: resolveChromiumPath() ? { executablePath: resolveChromiumPath() } : {},
  },
  webServer: {
    command: 'npm run start',
    url: 'http://127.0.0.1:4319/api/health',
    reuseExistingServer: false,
    timeout: 30000,
    env: { PORT: '4319', DATA_DIR: `data/ui-test-${process.pid}` },
  },
});
