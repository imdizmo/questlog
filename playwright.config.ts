import { defineConfig } from '@playwright/test';

/** E2E_DB picks another database file, so runs from two checkouts on one machine never share one. */
export const E2E_DB = process.env.E2E_DB ?? `${process.env.HOME}/.cache/gametracker/scratch/e2e.db`;
/** E2E_PORT picks another port when 8781 is taken on this machine. */
const PORT = Number(process.env.E2E_PORT ?? 8781);
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
  // The fake language pack (prefixes "[it] " / "[en] ") lets e2e/translate.spec.ts switch Translation on.
  webServer: {
    command: `pnpm build && env -u STRIPE_SECRET_KEY -u STRIPE_WEBHOOK_SECRET -u EMAIL_TRANSPORT JT_DB=${E2E_DB} JT_TRANSLATE_PACK=tests/fixtures/translate-pack PORT=${PORT} pnpm start`,
    url: `http://localhost:${PORT}/api/status`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
