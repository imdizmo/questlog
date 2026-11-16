import { rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { E2E_DB } from '../playwright.config';

// Runs before the webServer starts: every e2e run begins with an empty database.
export default function globalSetup() {
  mkdirSync(dirname(E2E_DB), { recursive: true });
  for (const f of [E2E_DB, `${E2E_DB}-wal`, `${E2E_DB}-shm`]) rmSync(f, { force: true });
}
