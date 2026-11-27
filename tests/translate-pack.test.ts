import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { TranslateEngine } from '../server/translate/engine';

// Runs only against a built language pack: JT_TRANSLATE_PACK_REAL=<folder holding pack.json and engine.mjs>
// (the models/translate folder of questlog-translate-models-*.tar.gz, see scripts/package-translate-pack.sh).
const REAL = process.env.JT_TRANSLATE_PACK_REAL;
let engine: TranslateEngine | undefined;
afterEach(async () => {
  await engine?.close();
  engine = undefined;
});

describe.skipIf(!REAL)('real language pack', () => {
  it('translates both ways and keeps placeholders', async () => {
    engine = new TranslateEngine({ packDir: join(REAL!) });
    const [en] = await engine.translate(['Ciao, come stai?'], 'it', 'en');
    expect(en.length).toBeGreaterThan(0);
    expect(en).not.toContain('⟦');
    expect(await engine.translate(['Parla con ⟦0⟧ prima di entrare in ⟦1⟧.'], 'it', 'en')).toEqual([
      expect.stringMatching(/^(?=.*⟦0⟧)(?=.*⟦1⟧)/),
    ]);
    const [it] = await engine.translate(['Hello, how are you?'], 'en', 'it');
    expect(it.length).toBeGreaterThan(0);
  }, 60_000);
});
