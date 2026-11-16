import { defineConfig } from '@playwright/test';

export const E2E_DB = `${process.env.HOME}/.cache/gametracker/scratch/e2e.db`;
const PORT = 8781;
export const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  use: {
    headless: true,
    baseURL: BASE_URL,
    launchOptions: { executablePath: '/usr/bin/chromium' },
  },
  webServer: {
    command: `pnpm build && env -u STRIPE_SECRET_KEY -u STRIPE_WEBHOOK_SECRET -u EMAIL_TRANSPORT JT_DB=${E2E_DB} PORT=${PORT} pnpm start`,
    url: `http://localhost:${PORT}/api/status`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
