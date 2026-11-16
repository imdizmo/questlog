/**
 * The server secret: signs links that must not be forged (email unsubscribe links, and later integration state).
 * JT_SECRET from the environment when set (at least 16 characters); otherwise a random key kept in `<dataDir>/secret.key`
 * (created on first start, readable by the owner only). Each use derives its own key with deriveKey(secret, purpose),
 * so one signed value never verifies for another purpose.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SECRET_FILE = 'secret.key';
const MIN_LENGTH = 16;

/** Throws unless `s` is long enough to be a secret. */
export function checkSecret(s: string, what = 'JT_SECRET'): string {
  if (s.length < MIN_LENGTH) throw new Error(`${what} must be at least ${MIN_LENGTH} characters long`);
  return s;
}

/**
 * The secret: JT_SECRET, else the key file (created once with an exclusive create; a file that exists but is too short
 * is an error, never silently replaced, since a new secret breaks every link already sent). A key file that others
 * can read is narrowed to the owner.
 */
export function loadSecret(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.JT_SECRET?.trim();
  if (fromEnv) return checkSecret(fromEnv);
  const file = join(dataDir, SECRET_FILE);
  mkdirSync(dataDir, { recursive: true });
  try {
    writeFileSync(file, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  if (statSync(file).mode & 0o077) {
    chmodSync(file, 0o600);
    console.warn(`[jt] ${file} was readable by other users; it is now readable by its owner only`);
  }
  return checkSecret(readFileSync(file, 'utf8').trim(), file);
}

/** A key for one purpose ("email-unsubscribe", ...): HMAC-SHA256 of the purpose under the secret. */
export const deriveKey = (secret: string, purpose: string): Buffer => createHmac('sha256', secret).update(`jt:${purpose}`).digest();
