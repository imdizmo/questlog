import { expect, it } from 'vitest';

it('node:sqlite provides DatabaseSync', async () => {
  const sqlite = await import('node:sqlite');
  expect(sqlite.DatabaseSync).toBeDefined();
});
