/**
 * Per-person preferences (server/prefs.ts, web/src/prefs.ts): small JSON values by key, such as `sidebar` or `tabs`.
 * Capped so one person's settings stay a few kilobytes: a value is at most MAX_PREF_BYTES of JSON, a person has at
 * most MAX_PREF_KEYS keys.
 */
export const PREF_KEY_RE = /^[a-z][a-zA-Z0-9.]{0,39}$/;
export const MAX_PREF_BYTES = 32 * 1024;
export const MAX_PREF_KEYS = 32;
