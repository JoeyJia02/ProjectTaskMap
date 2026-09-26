import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  },
  webServer: {
    command: 'node dist/server/server/index.js',
    url: 'http://127.0.0.1:3100/health',
    reuseExistingServer: false,
    env: {
      PORT: '3100', TASK_MAP_PUBLIC_URL: 'http://127.0.0.1:3100',
      TASK_MAP_OWNER_SECRET: 'e2e-only-owner-secret-never-use-in-production',
      TASK_MAP_SIGNING_SECRET: 'e2e-only-signing-secret-never-use-in-production',
      TASK_MAP_ALLOWED_ORIGINS: 'http://127.0.0.1:3100',
      TASK_MAP_DB: `.tmp/e2e-${Date.now()}.sqlite`,
    },
  },
});
